import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { runLogin, abortLoginFlow, type LoginDeps } from '../../src/tools/login.js';
import type { CallbackListener, OAuthConfig } from '../../src/auth/oauth-flow.js';

// README / US-1: a user can only open a URL they have been given. The original assertion was "the
// URL must survive every OUTCOME of zendesk_login", because the single call published it only at
// the end. The two-call flow moves the guarantee earlier and makes it stronger: the URL is the
// RESULT of call 1, returned before any waiting, and it is repeated by every later call that is
// still waiting for the callback. What stays unchanged is the counter-guarantee — a reply that
// cannot produce a usable URL must not promise one.
//
// Every test here drives the REAL localhost callback listener unless it says otherwise.

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

async function hitCallback(port: number, query: string): Promise<void> {
  await fetch(`http://localhost:${port}/callback${query}`);
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
  abortLoginFlow();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the authorization URL reaches the user before anything waits', () => {
  it('call 1 returns it without waiting for the callback', async () => {
    const port = await freePort();
    const started = Date.now();
    const text = await runLogin(deps(port, { callbackTimeoutMs: 60_000 }));
    // A minute-long listener is open, yet the call is back at once with the URL.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(authorizationUrl(text).host).toBe('acme.zendesk.com');
    expect(authorizationUrl(text).pathname).toBe('/oauth/authorizations/new');
  });

  it('a call made while the callback is still outstanding names it again', async () => {
    const port = await freePort();
    const d = deps(port, { callbackTimeoutMs: 60_000 });
    const first = await runLogin(d);
    const second = await runLogin(d);
    expect(second).toMatch(/still waiting/i);
    expect(authorizationUrl(second).toString()).toBe(authorizationUrl(first).toString());
  });

  it('never leaks the client secret alongside the URL', async () => {
    const port = await freePort();
    const first = await runLogin(deps(port, { callbackTimeoutMs: 60_000 }));
    const second = await runLogin(deps(port, { callbackTimeoutMs: 60_000 }));
    expect(first).not.toContain('secret-xyz');
    expect(second).not.toContain('secret-xyz');
  });
});

// The counter-case: a reply that cannot lead anywhere must not hand out a URL. After a flow has
// ended, its URL carries a dead `state` — repeating it would send the user into a state mismatch,
// which is exactly the bug the two-call design exists to remove.
describe('a reply that has no usable URL promises none', () => {
  it('a subdomain that cannot form a URL yields an actionable failure and promises no URL', async () => {
    const port = await freePort();
    const text = await runLogin(deps(port, { config: { ...config(port), subdomain: 'acme corp' } }));
    expect(text).toMatch(/Invalid URL/i);
    expect(text).toContain('Run zendesk_login again');
    expect(text).not.toContain('https://');
  });

  it('a blocked callback port names the remedy and promises no URL', async () => {
    const port = await freePort();
    const blocker = createHttpServer(() => {});
    await new Promise<void>((r) => blocker.listen(port, r));
    try {
      const text = await runLogin(deps(port));
      expect(text).toContain('oauth_callback_port');
      expect(text).not.toContain('https://');
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('a cancelled/denied authorization reports the reason and points at a NEW authorization', async () => {
    const port = await freePort();
    const d = deps(port);
    const first = await runLogin(d);
    expect(authorizationUrl(first).host).toBe('acme.zendesk.com');
    await hitCallback(port, '?error=access_denied');
    const second = await runLogin(d);
    expect(second).toMatch(/access_denied/);
    expect(second).toContain('Run zendesk_login again to start a new authorization');
    expect(second).not.toContain('https://');
  });

  it('reports a non-Error failure as plain text rather than swallowing it', async () => {
    const port = await freePort();
    const listen = (): CallbackListener => ({
      promise: Promise.resolve({ code: 'auth-code', redirectUri: `http://localhost:${port}/callback` }),
      ready: Promise.resolve(null),
      close: () => {},
    });
    const d = deps(port, {
      listen,
      // A dependency rejecting with a bare value must not degrade into "undefined".
      exchange: async () => {
        throw 'zendesk rejected the code';
      },
    });
    await runLogin(d);
    const text = await runLogin(d);
    expect(text).toContain('Zendesk login failed: zendesk rejected the code');
  });
});
