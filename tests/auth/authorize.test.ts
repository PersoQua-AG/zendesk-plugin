import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorize, type AuthorizeDeps } from '../../src/auth/authorize.js';
import { generateCodeChallenge } from '../../src/auth/pkce.js';
import { TokenStore } from '../../src/auth/token-store.js';
import type { OAuthConfig } from '../../src/auth/oauth-flow.js';

const config: OAuthConfig = {
  subdomain: 'acme',
  clientId: 'client-abc',
  clientSecret: 'secret-xyz',
  callbackPort: 8976,
  scopes: ['read', 'write'],
};

let dataDir: string;

function baseDeps(overrides: Partial<AuthorizeDeps> = {}): { deps: AuthorizeDeps; lines: string[] } {
  const lines: string[] = [];
  const deps: AuthorizeDeps = {
    config,
    dataDir,
    generateVerifier: () => 'fixed-verifier',
    generateState: () => 'fixed-state',
    now: () => 1_000_000,
    waitForCode: async () => ({ code: 'auth-code', redirectUri: `http://localhost:${config.callbackPort}/callback` }),
    exchange: async () => ({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 }),
    print: (line) => lines.push(line),
    ...overrides,
  };
  return { deps, lines };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'authz-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('authorize', () => {
  it('saves tokens the server can load with matching key/path', () => {
    const { deps } = baseDeps();
    return authorize(deps).then(() => {
      const stored = new TokenStore(`${dataDir}/tokens.enc`, config.clientSecret).load();
      expect(stored).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 1_000_000 + 3600 * 1000 });
    });
  });

  it('passes the same state to waitForCode that it embeds in the URL', async () => {
    let seenState: string | undefined;
    const { deps, lines } = baseDeps({
      waitForCode: async (_port, state) => {
        seenState = state;
        return { code: 'auth-code', redirectUri: `http://localhost:${config.callbackPort}/callback` };
      },
    });
    await authorize(deps);
    const url = new URL(lines.find((l) => l.startsWith('http')) ?? '');
    expect(url.searchParams.get('state')).toBe(seenState);
  });

  it('exchanges the verifier whose challenge appears in the URL', async () => {
    let seenVerifier: string | undefined;
    const { deps, lines } = baseDeps({
      exchange: async (_config, _code, verifier) => {
        seenVerifier = verifier;
        return { accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 };
      },
    });
    await authorize(deps);
    const url = new URL(lines.find((l) => l.startsWith('http')) ?? '');
    expect(url.searchParams.get('code_challenge')).toBe(generateCodeChallenge(seenVerifier ?? ''));
  });

  it('never prints secret or token material', async () => {
    const { deps, lines } = baseDeps();
    await authorize(deps);
    const output = lines.join('\n');
    expect(output).not.toContain(config.clientSecret);
    expect(output).not.toContain('access-1');
    expect(output).not.toContain('refresh-1');
  });

  it('rejects and writes no token file when the callback fails', async () => {
    const { deps } = baseDeps({
      waitForCode: async () => {
        throw new Error('callback timed out');
      },
    });
    await expect(authorize(deps)).rejects.toThrow('callback timed out');
    expect(existsSync(`${dataDir}/tokens.enc`)).toBe(false);
  });
});
