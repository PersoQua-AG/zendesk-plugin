import { describe, it, expect, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { runLogin, type LoginDeps } from '../../src/tools/login.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { exchangeCodeForTokens, type CallbackListener } from '../../src/auth/oauth-flow.js';
import {
  SECRET,
  authorizationUrl as urlIn,
  dataDir,
  deps,
  freePort,
  hitCallback,
  setupLoginHarness,
  tokensPath,
} from './login-harness.js';

// A listener stub whose callback has "already arrived": it binds nothing, so a test that only cares
// about what happens AFTER the redirect needs no real port. The two-stage walk over the REAL
// listener lives in login-two-step.test.ts.
function arrived(port: number, code = 'auth-code'): NonNullable<LoginDeps['listen']> {
  return async (): Promise<CallbackListener> => ({
    promise: Promise.resolve({ code, redirectUri: `http://localhost:${port}/callback` }),
    close: () => {},
  });
}

setupLoginHarness('login-tool-');

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
    // With the flow's own `state`, because Zendesk's denial redirect carries it too. Without one
    // the listener answers 400 and keeps waiting instead — deliberately, so that a stray local
    // request cannot end somebody's login (oauth-flow.stray-callback.test.ts).
    const state = urlIn(await runLogin(d)).searchParams.get('state') as string;
    await hitCallback(port, `?state=${state}&error=access_denied`);
    const text = await runLogin(d);
    expect(text).toMatch(/access_denied/);
    expect(text).toMatch(/zendesk_login/);
    expect(text).not.toMatch(/\bat .*\.(ts|js):\d+/);
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

  // NFR-1, measured: something in front of Zendesk (a WAF) answers the token POST with a whole
  // challenge page on ONE line, so a first-line-only cut quotes all ~8 KB of it — challenge token
  // included — straight into the tool result the user reads.
  it('never quotes an HTML error page from the token endpoint back to the user', async () => {
    const port = await freePort();
    const challenge = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>${'x'.repeat(8000)}<input name="cf_chl_tk" value="SENTINEL_CHALLENGE_TOKEN"></body></html>`;
    expect(challenge).not.toContain('\n');
    const wafFetch = (async () => new Response(challenge, { status: 403 })) as unknown as typeof fetch;
    const d = deps(port, {
      listen: arrived(port, 'c'),
      exchange: (cfg, code, verifier, uri) => exchangeCodeForTokens(cfg, code, verifier, uri, wafFetch),
    });
    await runLogin(d);
    const text = await runLogin(d);
    expect(text).not.toContain('SENTINEL_CHALLENGE_TOKEN');
    expect(text).not.toContain('cf_chl_tk');
    expect(text).not.toContain('<');
    // Still actionable: the status code and the retry hint survive the cut.
    expect(text).toContain('403');
    expect(text).toMatch(/zendesk_login/);
    expect(text.length).toBeLessThan(500);
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

  // A failed bind must leave NOTHING reserved. The old synchronous marker did reserve, and a single
  // EADDRINUSE then refused every later login for the lifetime of the process.
  it('reserves nothing when the bind fails, so the next login starts normally', async () => {
    const port = await freePort();
    const blocker = createHttpServer(() => {});
    await new Promise<void>((r) => blocker.listen(port, r));
    try {
      expect(await runLogin(deps(port))).toContain('oauth_callback_port');
    } finally {
      await new Promise((r) => blocker.close(r));
    }
    const next = await runLogin(deps(port, { callbackTimeoutMs: 60_000 }));
    expect(next).toMatch(/authorization started/i);
    expect(next).not.toMatch(/still waiting/i);
    expect(urlIn(next).host).toBe('acme.zendesk.com');
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
