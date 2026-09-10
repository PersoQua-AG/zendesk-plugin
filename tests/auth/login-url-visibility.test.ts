import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { runLogin, type LoginDeps } from '../../src/tools/login.js';
import type { OAuthConfig } from '../../src/auth/oauth-flow.js';

// README / US-1: "run zendesk_login. It returns a Zendesk authorization URL — open it, approve, and
// the extension captures the callback." A user can only open a URL they have been given, so the URL
// must reach the caller on every run that does NOT end in a stored token — otherwise the feature can
// never succeed for a real Desktop user.
//
// Every test here drives the REAL localhost callback listener (no waitForCode stub), so the real
// ordering — print the URL, then block on the callback — is what is exercised.

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
  return { subdomain: 'acme', clientId: 'client-abc', clientSecret: 'secret-xyz', callbackPort: port, scopes: ['read', 'write'] };
}

function deps(port: number, overrides: Partial<LoginDeps> = {}): LoginDeps {
  return { config: config(port), tokensPath, ...overrides };
}

// Retry until the real listener is bound, then hit /callback.
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

function authorizationUrl(text: string): URL {
  const raw = text.split(/\s+/).find((w) => w.startsWith('https://'));
  expect(raw, `no authorization URL in:\n${text}`).toBeDefined();
  return new URL(raw as string);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'login-url-'));
  tokensPath = join(dataDir, 'tokens.enc');
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the authorization URL survives every outcome of zendesk_login', () => {
  it('a run that times out without a callback still names the URL to open', async () => {
    const port = await freePort();
    const text = await runLogin(deps(port, { callbackTimeoutMs: 50 }));
    expect(text).toMatch(/timed out/i);
    expect(authorizationUrl(text).host).toBe('acme.zendesk.com');
  });

  it('a cancelled/denied authorization still names the URL to open', async () => {
    const port = await freePort();
    const pending = runLogin(deps(port));
    await hitCallback(port, '?error=access_denied');
    const text = await pending;
    expect(text).toMatch(/access_denied/);
    expect(authorizationUrl(text).pathname).toBe('/oauth/authorizations/new');
  });

  it('a state mismatch still names the URL to open', async () => {
    const port = await freePort();
    const pending = runLogin(deps(port));
    await hitCallback(port, '?state=wrong&code=abc');
    const text = await pending;
    expect(text).toMatch(/state mismatch/i);
    expect(authorizationUrl(text).host).toBe('acme.zendesk.com');
  });

  it('a blocked callback port still names the URL to open', async () => {
    const port = await freePort();
    const blocker = createHttpServer(() => {});
    await new Promise<void>((r) => blocker.listen(port, r));
    try {
      const text = await runLogin(deps(port));
      expect(text).toContain('oauth_callback_port');
      expect(authorizationUrl(text).host).toBe('acme.zendesk.com');
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  // The counter-case: when no URL could be built at all, the reply must NOT promise one. A
  // subdomain the user mistyped (a space, a full host) fails inside buildAuthorizationUrl, before
  // anything is printed — the only path on which there is nothing to open.
  it('a subdomain that cannot form a URL yields an actionable failure and promises no URL', async () => {
    const port = await freePort();
    const text = await runLogin(deps(port, { config: { ...config(port), subdomain: 'acme corp' } }));
    expect(text).toMatch(/Invalid URL/i);
    expect(text).toContain('Run zendesk_login again');
    expect(text).not.toContain('Authorization URL for this attempt');
    expect(text).not.toContain('https://');
  });

  it('reports a non-Error failure as plain text rather than swallowing it', async () => {
    const port = await freePort();
    const text = await runLogin(
      deps(port, {
        waitForCode: async () => ({ code: 'auth-code', redirectUri: `http://localhost:${port}/callback` }),
        // A dependency rejecting with a bare value must not degrade into "undefined".
        exchange: async () => {
          throw 'zendesk rejected the code';
        },
      }),
    );
    expect(text).toContain('Zendesk login failed: zendesk rejected the code');
    expect(authorizationUrl(text).host).toBe('acme.zendesk.com');
  });

  it('never leaks the client secret alongside the URL', async () => {
    const port = await freePort();
    const text = await runLogin(deps(port, { callbackTimeoutMs: 50 }));
    expect(text).not.toContain('secret-xyz');
  });
});

describe('two zendesk_login calls at once', () => {
  it('the second call does not blame the user for the port the FIRST login occupies', async () => {
    const port = await freePort();
    const first = runLogin(deps(port, { callbackTimeoutMs: 400 }));
    // Let the first listener bind, then start a second login against the same port.
    await new Promise((r) => setTimeout(r, 100));
    const second = await runLogin(deps(port, { callbackTimeoutMs: 400 }));
    await first;

    expect(second).not.toContain('Close whatever is listening');
    expect(second).toMatch(/already waiting for the callback/i);
    expect(second).toContain(String(port));
  });

  it('releases the marker again, so a later login is not refused', async () => {
    const port = await freePort();
    await runLogin(deps(port, { callbackTimeoutMs: 50 }));
    const next = await runLogin(deps(port, { callbackTimeoutMs: 50 }));
    expect(next).not.toMatch(/already waiting/i);
    expect(next).toMatch(/timed out/i);
  });
});
