import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { runLogin, abortLoginFlow, type LoginDeps } from '../../src/tools/login.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { exchangeCodeForTokens, type CallbackListener, type OAuthConfig } from '../../src/auth/oauth-flow.js';

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

// A listener stub whose callback has "already arrived": it binds nothing, so a test that only cares
// about what happens AFTER the redirect needs no real port. The two-stage walk over the REAL
// listener lives in login-two-step.test.ts.
function arrived(port: number, code = 'auth-code'): NonNullable<LoginDeps['listen']> {
  return (): CallbackListener => ({
    promise: Promise.resolve({ code, redirectUri: `http://localhost:${port}/callback` }),
    ready: Promise.resolve(null),
    close: () => {},
  });
}

// Drive the REAL localhost callback listener. Call 1 awaits the bind, so no retry loop is needed.
async function hitCallback(port: number, query: string): Promise<void> {
  await fetch(`http://localhost:${port}/callback${query}`);
}

function urlIn(text: string): URL {
  const raw = text.split(/\s+/).find((w) => w.startsWith('https://'));
  expect(raw, `no authorization URL in:\n${text}`).toBeDefined();
  return new URL(raw as string);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'login-tool-'));
  tokensPath = join(dataDir, 'tokens.enc');
});
afterEach(() => {
  // Flow state is module-level: it must not leak into the next case, nor leave a listener bound.
  abortLoginFlow();
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('zendesk_login happy path', () => {
  it('call 1 returns the authorization URL, call 2 stores tokens the server can load', async () => {
    const port = await freePort();
    const d = deps(port, {
      listen: arrived(port),
      exchange: async () => ({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 }),
    });

    const first = await runLogin(d);
    const url = urlIn(first);
    expect(url.host).toBe('acme.zendesk.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(`http://localhost:${port}/callback`);
    expect(first).toMatch(/run zendesk_login a second time/i);
    // Nothing is stored yet — call 1 has not exchanged anything.
    expect(existsSync(tokensPath)).toBe(false);

    const second = await runLogin(d);
    expect(second).toMatch(/authorization complete/i);
    expect(new TokenStore(tokensPath, SECRET).load()).toMatchObject({ accessToken: 'access-1' });
  });

  it('never leaks the client secret, tokens, or the authorization code', async () => {
    const port = await freePort();
    const d = deps(port, {
      listen: arrived(port),
      exchange: async () => ({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 }),
    });
    for (const text of [await runLogin(d), await runLogin(d)]) {
      for (const secret of [SECRET, 'access-1', 'refresh-1', 'auth-code']) expect(text).not.toContain(secret);
    }
  });

  it('writes nothing to stdout (stdout is the MCP stdio transport)', async () => {
    const port = await freePort();
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const d = deps(port, { listen: arrived(port), exchange: async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }) });
    await runLogin(d);
    await runLogin(d);
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
    const listen = vi.fn();
    const text = await runLogin(deps(port, { listen: listen as unknown as LoginDeps['listen'] }));
    expect(text).toMatch(/already authorized/i);
    expect(listen).not.toHaveBeenCalled();
  });

  it('force starts a new flow and replaces the tokens only after a successful exchange', async () => {
    const port = await freePort();
    seedTokens();
    const d = deps(port, {
      listen: arrived(port, 'c'),
      exchange: async () => ({ accessToken: 'a-new', refreshToken: 'r-new', expiresIn: 3600 }),
    });
    const first = await runLogin(d, { force: true });
    expect(first).not.toMatch(/already authorized/i);
    expect(urlIn(first).host).toBe('acme.zendesk.com');
    // Still the old tokens: nothing is replaced until the code has come back and been exchanged.
    expect(new TokenStore(tokensPath, SECRET).load()).toMatchObject({ accessToken: 'a-old' });

    await runLogin(d);
    expect(new TokenStore(tokensPath, SECRET).load()).toMatchObject({ accessToken: 'a-new' });
  });

  it('keeps the existing tokens when the forced flow fails', async () => {
    const port = await freePort();
    seedTokens();
    const d = deps(port, {
      listen: arrived(port, 'c'),
      exchange: async () => {
        throw new Error('Token exchange failed: 400');
      },
    });
    await runLogin(d, { force: true });
    const second = await runLogin(d);
    expect(second).toMatch(/zendesk_login/);
    expect(new TokenStore(tokensPath, SECRET).load()).toMatchObject({ accessToken: 'a-old' });
  });
});

describe('zendesk_login negative paths', () => {
  it('reports a cancelled/denied authorization in plain text with no stack trace', async () => {
    const port = await freePort();
    const d = deps(port);
    await runLogin(d);
    await hitCallback(port, '?error=access_denied');
    const text = await runLogin(d);
    expect(text).toMatch(/access_denied/);
    expect(text).toMatch(/zendesk_login/);
    expect(text).not.toMatch(/\bat .*\.(ts|js):\d+/);
    expect(existsSync(tokensPath)).toBe(false);
  });

  it('reports a state mismatch without writing a token file', async () => {
    const port = await freePort();
    const d = deps(port);
    await runLogin(d);
    await hitCallback(port, '?state=wrong&code=abc');
    const text = await runLogin(d);
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
    const d = deps(port, {
      listen: arrived(port, 'c'),
      exchange: (cfg, code, verifier, uri) => exchangeCodeForTokens(cfg, code, verifier, uri, badFetch),
    });
    await runLogin(d);
    const text = await runLogin(d);
    expect(text).toMatch(/access_token/);
    expect(text).not.toContain('TOP_SECRET_BODY');
    expect(existsSync(tokensPath)).toBe(false);
  });

  it('names the port and the oauth_callback_port field when the callback port is taken', async () => {
    const port = await freePort();
    const blocker = createHttpServer(() => {});
    await new Promise<void>((r) => blocker.listen(port, r));
    try {
      // Call 1 reports the bind failure itself, rather than handing out a URL whose callback could
      // never land — it waits for the bind result, which is immediate.
      const text = await runLogin(deps(port));
      expect(text).toContain(String(port));
      expect(text).toContain('oauth_callback_port');
      expect(text).not.toMatch(/EADDRINUSE/);
      expect(text).not.toContain('https://');
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('times out, closes the listener, and leaves the port free for a retry', async () => {
    const port = await freePort();
    const d = deps(port, { callbackTimeoutMs: 30 });
    await runLogin(d);
    await new Promise((r) => setTimeout(r, 80));
    const text = await runLogin(d);
    expect(text).toMatch(/timed out/i);
    expect(text).toMatch(/zendesk_login/);
    // The listener must be gone: re-binding the same port succeeds.
    const probe = createHttpServer(() => {});
    await new Promise<void>((r) => probe.listen(port, r));
    await new Promise((r) => probe.close(r));
  });

  it('never puts the token file path into an error message', async () => {
    const port = await freePort();
    const d = deps(port, {
      listen: arrived(port, 'c'),
      exchange: async () => {
        throw new Error(`EACCES: permission denied, open '${tokensPath}'`);
      },
    });
    await runLogin(d);
    const text = await runLogin(d);
    expect(text).not.toContain(tokensPath);
    expect(text).not.toContain(dataDir);
  });
});

describe('zendesk_login with an unreadable token store', () => {
  it('says the stored credentials were discarded, without a path or a stack trace', async () => {
    const port = await freePort();
    // What a rotated client secret looks like from here: a file the TokenStore cannot decrypt.
    writeFileSync(tokensPath, 'not-a-valid-encrypted-token-file');
    const d = deps(port, {
      listen: arrived(port, 'c'),
      exchange: async () => ({ accessToken: 'a-new', refreshToken: 'r-new', expiresIn: 3600 }),
    });
    const first = await runLogin(d);
    expect(first).toMatch(/could not be read/i);
    expect(first).toMatch(/encryption secret changed or file corrupt/i);
    expect(first).not.toContain(tokensPath);
    expect(first).not.toContain(dataDir);
    expect(first).not.toMatch(/\bat .*\.(ts|js):\d+/);
    // The fresh flow still runs to completion — on the second call.
    await runLogin(d);
    expect(new TokenStore(tokensPath, SECRET).load()).toMatchObject({ accessToken: 'a-new' });
  });
});

describe('zendesk_login with incomplete extension configuration', () => {
  it('returns the actionable configuration message and touches nothing', async () => {
    const port = await freePort();
    const listen = vi.fn();
    const text = await runLogin(
      deps(port, {
        configError: 'Missing required environment variable: ZENDESK_SUBDOMAIN (extension configuration field "zendesk_subdomain" is empty).',
        listen: listen as unknown as LoginDeps['listen'],
      }),
    );
    expect(text).toContain('zendesk_subdomain');
    expect(listen).not.toHaveBeenCalled();
    expect(existsSync(tokensPath)).toBe(false);
  });
});
