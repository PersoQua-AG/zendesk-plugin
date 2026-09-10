import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { runLogin, type LoginDeps } from '../../src/tools/login.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { exchangeCodeForTokens, type OAuthConfig } from '../../src/auth/oauth-flow.js';

const SECRET = 'secret-xyz';

let dataDir: string;
let tokensPath: string;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createHttpServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function config(port: number): OAuthConfig {
  return { subdomain: 'acme', clientId: 'client-abc', clientSecret: SECRET, callbackPort: port, scopes: ['read', 'write'] };
}

function deps(port: number, overrides: Partial<LoginDeps> = {}): LoginDeps {
  return { config: config(port), tokensPath, ...overrides };
}

// Drive the REAL localhost callback listener: retry until it is bound, then hit /callback.
async function hitCallback(port: number, query: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://localhost:${port}/callback${query}`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error('callback listener never came up');
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'login-tool-'));
  tokensPath = join(dataDir, 'tokens.enc');
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('zendesk_login happy path', () => {
  it('returns the authorization URL and stores tokens the server can load', async () => {
    const port = await freePort();
    const text = await runLogin(
      deps(port, {
        waitForCode: async () => ({ code: 'auth-code', redirectUri: `http://localhost:${port}/callback` }),
        exchange: async () => ({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 }),
      }),
    );

    const url = new URL(text.split(/\s+/).find((w) => w.startsWith('https://')) ?? '');
    expect(url.host).toBe('acme.zendesk.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(`http://localhost:${port}/callback`);
    expect(new TokenStore(tokensPath, SECRET).load()).toMatchObject({ accessToken: 'access-1' });
  });

  it('never leaks the client secret, tokens, or the authorization code', async () => {
    const port = await freePort();
    const text = await runLogin(
      deps(port, {
        waitForCode: async () => ({ code: 'auth-code', redirectUri: `http://localhost:${port}/callback` }),
        exchange: async () => ({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 }),
      }),
    );
    for (const secret of [SECRET, 'access-1', 'refresh-1', 'auth-code']) expect(text).not.toContain(secret);
  });

  it('writes nothing to stdout (stdout is the MCP stdio transport)', async () => {
    const port = await freePort();
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runLogin(
      deps(port, {
        waitForCode: async () => ({ code: 'auth-code', redirectUri: `http://localhost:${port}/callback` }),
        exchange: async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }),
      }),
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('zendesk_login when already authorized', () => {
  function seedTokens(): void {
    new TokenStore(tokensPath, SECRET).save({ accessToken: 'a-old', refreshToken: 'r-old', expiresAt: Date.now() + 3_600_000 });
  }

  it('reports authorized without starting a browser/network flow', async () => {
    const port = await freePort();
    seedTokens();
    const waitForCode = vi.fn();
    const text = await runLogin(deps(port, { waitForCode: waitForCode as unknown as LoginDeps['waitForCode'] }));
    expect(text).toMatch(/already authorized/i);
    expect(waitForCode).not.toHaveBeenCalled();
  });

  it('force starts a new flow and replaces the tokens only after a successful exchange', async () => {
    const port = await freePort();
    seedTokens();
    const text = await runLogin(
      deps(port, {
        waitForCode: async () => ({ code: 'c', redirectUri: `http://localhost:${port}/callback` }),
        exchange: async () => ({ accessToken: 'a-new', refreshToken: 'r-new', expiresIn: 3600 }),
      }),
      true,
    );
    expect(text).not.toMatch(/already authorized/i);
    expect(new TokenStore(tokensPath, SECRET).load()).toMatchObject({ accessToken: 'a-new' });
  });

  it('keeps the existing tokens when the forced flow fails', async () => {
    const port = await freePort();
    seedTokens();
    const text = await runLogin(
      deps(port, {
        waitForCode: async () => ({ code: 'c', redirectUri: `http://localhost:${port}/callback` }),
        exchange: async () => {
          throw new Error('Token exchange failed: 400');
        },
      }),
      true,
    );
    expect(text).toMatch(/zendesk_login/);
    expect(new TokenStore(tokensPath, SECRET).load()).toMatchObject({ accessToken: 'a-old' });
  });
});

describe('zendesk_login negative paths', () => {
  it('reports a cancelled/denied authorization in plain text with no stack trace', async () => {
    const port = await freePort();
    const pending = runLogin(deps(port));
    await hitCallback(port, '?error=access_denied');
    const text = await pending;
    expect(text).toMatch(/access_denied/);
    expect(text).toMatch(/zendesk_login/);
    expect(text).not.toMatch(/\bat .*\.(ts|js):\d+/);
    expect(existsSync(tokensPath)).toBe(false);
  });

  it('reports a state mismatch without writing a token file', async () => {
    const port = await freePort();
    const pending = runLogin(deps(port));
    await hitCallback(port, '?state=wrong&code=abc');
    const text = await pending;
    expect(text).toMatch(/state mismatch/i);
    expect(existsSync(tokensPath)).toBe(false);
  });

  it('names only the invalid fields of a malformed token response, never the raw body', async () => {
    const port = await freePort();
    const badFetch = (async () =>
      new Response(JSON.stringify({ refresh_token: 'r', expires_in: 3600, leaked: 'TOP_SECRET_BODY' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const text = await runLogin(
      deps(port, {
        waitForCode: async () => ({ code: 'c', redirectUri: `http://localhost:${port}/callback` }),
        exchange: (cfg, code, verifier, uri) => exchangeCodeForTokens(cfg, code, verifier, uri, badFetch),
      }),
    );
    expect(text).toMatch(/access_token/);
    expect(text).not.toContain('TOP_SECRET_BODY');
    expect(existsSync(tokensPath)).toBe(false);
  });

  it('names the port and the oauth_callback_port field when the callback port is taken', async () => {
    const port = await freePort();
    const blocker = createHttpServer(() => {});
    await new Promise<void>((r) => blocker.listen(port, r));
    try {
      const text = await runLogin(deps(port));
      expect(text).toContain(String(port));
      expect(text).toContain('oauth_callback_port');
      expect(text).not.toMatch(/EADDRINUSE/);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('times out, closes the listener, and leaves the port free for a retry', async () => {
    const port = await freePort();
    const text = await runLogin(deps(port, { callbackTimeoutMs: 30 }));
    expect(text).toMatch(/timed out/i);
    expect(text).toMatch(/zendesk_login/);
    // The listener must be gone: re-binding the same port succeeds.
    const probe = createHttpServer(() => {});
    await new Promise<void>((r) => probe.listen(port, r));
    await new Promise((r) => probe.close(r));
  });

  it('never puts the token file path into an error message', async () => {
    const port = await freePort();
    const text = await runLogin(
      deps(port, {
        waitForCode: async () => ({ code: 'c', redirectUri: `http://localhost:${port}/callback` }),
        exchange: async () => {
          throw new Error(`EACCES: permission denied, open '${tokensPath}'`);
        },
      }),
    );
    expect(text).not.toContain(tokensPath);
    expect(text).not.toContain(dataDir);
  });
});

describe('zendesk_login with incomplete extension configuration', () => {
  it('returns the actionable configuration message and touches nothing', async () => {
    const port = await freePort();
    const waitForCode = vi.fn();
    const text = await runLogin(
      deps(port, {
        configError: 'Missing required environment variable: ZENDESK_SUBDOMAIN (extension configuration field "zendesk_subdomain" is empty).',
        waitForCode: waitForCode as unknown as LoginDeps['waitForCode'],
      }),
    );
    expect(text).toContain('zendesk_subdomain');
    expect(waitForCode).not.toHaveBeenCalled();
    expect(existsSync(tokensPath)).toBe(false);
  });
});
