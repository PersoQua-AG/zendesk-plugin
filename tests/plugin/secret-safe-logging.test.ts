import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { exchangeCodeForTokens, refreshAccessToken, type OAuthConfig } from '../../src/auth/oauth-flow.js';
import { AuthManager } from '../../src/auth/auth-manager.js';
import type { TokenStore } from '../../src/auth/token-store.js';

const SRC = join(process.cwd(), 'src');

// stdout is the MCP stdio transport: any stray write corrupts the protocol AND
// could leak a secret. Only the standalone CLI (not loaded by the server) may
// write to stdout — it prints the authorization URL/status.
const STDOUT_ALLOWLIST = ['bin/', 'auth/authorize.ts'];
const STDOUT_WRITE = /console\.(log|info|debug)\s*\(|process\.stdout/;

// stderr is safe for the stdio protocol, but only the CLI and the report config
// parser (config-degradation warnings) are permitted to use it; every other
// server-loaded module must stay silent so nothing can leak.
const STDERR_ALLOWLIST = ['bin/', 'auth/authorize.ts', 'tools/analytics/business-hours.ts'];
const STDERR_WRITE = /console\.(warn|error|trace|dir|table|group|count|assert)\s*\(|process\.stderr/;

function srcFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map((p) => String(p).split('\\').join('/'))
    .filter((p) => p.endsWith('.ts'));
}

function allowed(rel: string, allowlist: string[]): boolean {
  return allowlist.some((a) => posix.normalize(rel).startsWith(a) || rel.endsWith(a));
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
  it('only the CLI writes to stdout (console.log/info/debug or process.stdout)', () => {
    for (const rel of srcFiles()) {
      if (allowed(rel, STDOUT_ALLOWLIST)) continue;
      const source = readFileSync(join(SRC, rel), 'utf8');
      expect(source, `${rel} must not write to stdout`).not.toMatch(STDOUT_WRITE);
    }
  });

  it('only the CLI + report config parser write to stderr (console.warn/error/… or process.stderr)', () => {
    for (const rel of srcFiles()) {
      if (allowed(rel, STDERR_ALLOWLIST)) continue;
      const source = readFileSync(join(SRC, rel), 'utf8');
      expect(source, `${rel} must not write to stderr`).not.toMatch(STDERR_WRITE);
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
