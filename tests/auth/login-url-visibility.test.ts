import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { runLogin, type LoginDeps } from '../../src/tools/login.js';
import type { CallbackListener } from '../../src/auth/oauth-flow.js';
import { authorizationUrl, config, deps, freePort, hitCallback, setupLoginHarness, tokensPath } from './login-harness.js';

// README / US-1: a user can only open a URL they have been given. The URL is the RESULT of call 1,
// returned before any waiting, and it is repeated by every later call still waiting for the
// callback. The counter-guarantee, which the second describe holds: a reply that cannot produce a
// usable URL must not promise one.
//
// Every test here drives the REAL localhost callback listener unless it says otherwise.

setupLoginHarness('login-url-');

describe('the authorization URL reaches the user before anything waits', () => {
  it('call 1 returns it without waiting for the callback', async () => {
    const port = freePort();
    const started = Date.now();
    const text = await runLogin(deps(port, { callbackTimeoutMs: 60_000 }));
    // A minute-long listener is open, yet the call is back at once with the URL.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(authorizationUrl(text).host).toBe('acme.zendesk.com');
    expect(authorizationUrl(text).pathname).toBe('/oauth/authorizations/new');
  });

  it('a call made while the callback is still outstanding names it again', async () => {
    const port = freePort();
    const d = deps(port, { callbackTimeoutMs: 60_000 });
    const first = await runLogin(d);
    const second = await runLogin(d);
    expect(second).toMatch(/still waiting/i);
    expect(second).toContain(String(port));
    expect(authorizationUrl(second).toString()).toBe(authorizationUrl(first).toString());
    // Repeating the notice must stay a read: nothing is exchanged and nothing is stored while the
    // callback is still outstanding.
    expect(existsSync(tokensPath)).toBe(false);
  });
});

// The counter-case: a reply that cannot lead anywhere must not hand out a URL. After a flow has
// ended, its URL carries a dead `state` and the listener that validated it is closed — repeating it
// would send the user to a callback that reaches nothing, which is exactly the bug the two-call
// design exists to remove.
describe('a reply that has no usable URL promises none', () => {
  it('a subdomain that cannot form a URL yields an actionable failure and promises no URL', async () => {
    const port = freePort();
    const text = await runLogin(deps(port, { config: { ...config(port), subdomain: 'acme corp' } }));
    expect(text).toMatch(/Invalid URL/i);
    expect(text).toContain('Run zendesk_login again');
    expect(text).not.toContain('https://');
  });

  it('a blocked callback port names the remedy and promises no URL', async () => {
    const port = freePort();
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
    const port = freePort();
    const d = deps(port);
    const first = await runLogin(d);
    expect(authorizationUrl(first).host).toBe('acme.zendesk.com');
    // The denial carries the flow's `state`, as Zendesk's does — see oauth-flow.stray-callback.test.ts
    // for why a denial without one no longer ends the flow.
    await hitCallback(port, `?state=${authorizationUrl(first).searchParams.get('state')}&error=access_denied`);
    const second = await runLogin(d);
    expect(second).toMatch(/access_denied/);
    expect(second).toContain('Run zendesk_login again to start a new authorization');
    expect(second).not.toContain('https://');
  });

  it('reports a non-Error failure as plain text rather than swallowing it', async () => {
    const port = freePort();
    const listen: NonNullable<LoginDeps['listen']> = async (): Promise<CallbackListener> => ({
      promise: Promise.resolve({ code: 'auth-code', redirectUri: `http://localhost:${port}/callback` }),
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
