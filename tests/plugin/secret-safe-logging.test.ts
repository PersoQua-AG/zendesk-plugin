import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { exchangeCodeForTokens, refreshAccessToken, type OAuthConfig } from '../../src/auth/oauth-flow.js';
import { AuthManager } from '../../src/auth/auth-manager.js';
import type { TokenStore } from '../../src/auth/token-store.js';

const SRC = join(process.cwd(), 'src');

// stdout is the MCP stdio transport: any stray write corrupts the protocol.
// Only the standalone CLI (not loaded by the server) may write to stdout.
const STDOUT_ALLOWLIST = ['bin/', 'auth/authorize.ts'];

function srcFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map((p) => String(p).split('\\').join('/'))
    .filter((p) => p.endsWith('.ts'));
}

const SENTINEL = 'SENTINEL_SECRET';
const config: OAuthConfig = {
  subdomain: 'acme',
  clientId: 'client-abc',
  clientSecret: SENTINEL,
  callbackPort: 8976,
  scopes: ['read', 'write'],
};

const failingFetch = (async () =>
  new Response('invalid_grant', { status: 400 })) as unknown as typeof fetch;

describe('secret-safe logging (static guard)', () => {
  it('no server-loaded module uses console.log', () => {
    for (const rel of srcFiles()) {
      const source = readFileSync(join(SRC, rel), 'utf8');
      expect(source, `${rel} must not use console.log`).not.toMatch(/console\.log\s*\(/);
    }
  });

  it('only the CLI writes to process.stdout', () => {
    for (const rel of srcFiles()) {
      if (STDOUT_ALLOWLIST.some((a) => posix.normalize(rel).startsWith(a) || rel.endsWith(a))) continue;
      const source = readFileSync(join(SRC, rel), 'utf8');
      expect(source, `${rel} must not write to process.stdout`).not.toMatch(/process\.stdout/);
    }
  });
});

describe('secret-safe errors', () => {
  it('exchangeCodeForTokens error omits the client secret', async () => {
    await expect(exchangeCodeForTokens(config, 'code', 'verifier', 'uri', failingFetch)).rejects.toThrow(
      /^(?!.*SENTINEL_SECRET).*$/,
    );
  });

  it('refreshAccessToken error omits the client secret', async () => {
    await expect(refreshAccessToken(config, 'refresh', failingFetch)).rejects.toThrow(
      /^(?!.*SENTINEL_SECRET).*$/,
    );
  });

  it('AuthManager surfaces re-auth guidance without token material', async () => {
    const throwingStore = {
      load: () => {
        throw new Error('gcm auth tag mismatch');
      },
    } as unknown as TokenStore;
    const manager = new AuthManager(throwingStore, config);
    await expect(manager.getAccessToken()).rejects.toThrow(/re-authorize/i);
    await expect(manager.getAccessToken()).rejects.not.toThrow(/SENTINEL_SECRET/);
  });

  it('AuthManager reports missing authorization without token material', async () => {
    const emptyStore = { load: () => null } as unknown as TokenStore;
    const manager = new AuthManager(emptyStore, config);
    await expect(manager.getAccessToken()).rejects.toThrow(/No Zendesk authorization found/);
  });
});
