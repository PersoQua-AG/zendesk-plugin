import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { runLogin } from '../../src/tools/login.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { generateCodeChallenge } from '../../src/auth/pkce.js';
import { SECRET, authorizationUrl, deps, freePort, rebind, redirect, setupLoginHarness, tokensPath } from './login-harness.js';

// The two-call login, walked over the REAL localhost listener — no listener stub anywhere in this
// file. This is the level at which the previous design failed while its suite stayed green: the
// tests stubbed the wait, so nobody noticed that a human could never reach the happy path (the URL
// arrived only after the call had finished waiting, and the retry re-rolled the `state` that the
// already-published URL carried). Only the token exchange is stubbed, so no test touches Zendesk.

setupLoginHarness('login-two-step-');

describe('the two-call login over the real callback listener', () => {
  it('call 1 hands out the URL, the browser redirect lands, call 2 completes the login', async () => {
    const port = await freePort();
    let exchanged: { code: string; verifier: string; redirectUri: string } | null = null;
    const d = deps(port, {
      exchange: async (_cfg, code, verifier, redirectUri) => {
        exchanged = { code, verifier, redirectUri };
        return { accessToken: 'access-e2e', refreshToken: 'refresh-e2e', expiresIn: 3600 };
      },
    });

    const first = await runLogin(d);
    const url = authorizationUrl(first);
    expect(existsSync(tokensPath)).toBe(false);

    const response = await redirect(url, { state: url.searchParams.get('state') as string, code: 'browser-code' });
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/close this tab/i);

    const second = await runLogin(d);
    expect(second).toMatch(/authorization complete/i);
    expect(new TokenStore(tokensPath, SECRET).load()).toMatchObject({ accessToken: 'access-e2e' });

    // The code came from the real listener, and the PKCE verifier used on call 2 is the one whose
    // challenge went out in call 1's URL — proof that the flow, not the call, owns the secret.
    expect(exchanged).toMatchObject({ code: 'browser-code', redirectUri: `http://localhost:${port}/callback` });
    expect(generateCodeChallenge((exchanged as unknown as { verifier: string }).verifier)).toBe(url.searchParams.get('code_challenge'));

    // Nothing is left listening once the flow is collected.
    await rebind(port);
  });

  it('keeps the same state across calls, so the URL handed out first still works', async () => {
    const port = await freePort();
    const d = deps(port, {
      callbackTimeoutMs: 60_000,
      exchange: async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }),
    });
    const first = authorizationUrl(await runLogin(d));
    const second = authorizationUrl(await runLogin(d));
    const state = first.searchParams.get('state') as string;

    expect(state).toBeTruthy();
    expect(second.searchParams.get('state')).toBe(state);
    expect(second.searchParams.get('code_challenge')).toBe(first.searchParams.get('code_challenge'));

    // And the listener still accepts exactly that state.
    expect((await redirect(first, { state, code: 'c' })).status).toBe(200);
    expect(await runLogin(d)).toMatch(/authorization complete/i);
  });

  // A foreign `state` stores nothing — and no longer ENDS the user's login either. Any local
  // process can reach the callback port while the window is open, so a stray request that could
  // fail the flow was a way to break every login attempt from outside; it now answers 400 and the
  // user's own authorization is still there to be finished. Whole reasoning in
  // oauth-flow.stray-callback.test.ts.
  it('refuses a callback that carries a foreign state, stores nothing, and keeps the login alive', async () => {
    const port = await freePort();
    const d = deps(port, { callbackTimeoutMs: 60_000 });
    const url = authorizationUrl(await runLogin(d));

    const response = await redirect(url, { state: 'not-the-flow-state', code: 'c' });
    expect(response.status).toBe(400);
    expect(existsSync(tokensPath)).toBe(false);

    // Still the same authorization, still the same URL — the user is not sent to start over.
    const still = await runLogin(d);
    expect(still).toMatch(/still waiting/i);
    expect(authorizationUrl(still).searchParams.get('state')).toBe(url.searchParams.get('state'));
  });
});

describe('a flow that ends without a callback', () => {
  it('times out, cleans up, and the next login starts over with a NEW state', async () => {
    const port = await freePort();
    const d = deps(port, { callbackTimeoutMs: 30 });
    const stale = authorizationUrl(await runLogin(d));
    await new Promise((r) => setTimeout(r, 80));

    // The listener is already gone when the timeout fires, before anyone collects it.
    await rebind(port);

    const collected = await runLogin(d);
    expect(collected).toMatch(/timed out/i);
    expect(collected).toContain('start a new authorization');

    const fresh = authorizationUrl(await runLogin(d));
    expect(fresh.searchParams.get('state')).not.toBe(stale.searchParams.get('state'));
    expect(fresh.searchParams.get('code_challenge')).not.toBe(stale.searchParams.get('code_challenge'));
  });

  it('force abandons the flow in progress and starts a new one on the same port', async () => {
    const port = await freePort();
    const d = deps(port, { callbackTimeoutMs: 60_000 });
    const stale = authorizationUrl(await runLogin(d));

    const restarted = await runLogin(d, { force: true });
    const fresh = authorizationUrl(restarted);
    expect(restarted).not.toMatch(/still waiting/i);
    expect(fresh.searchParams.get('state')).not.toBe(stale.searchParams.get('state'));

    // The abandoned state is dead; only the new one is accepted. A browser that comes back on the
    // OLD URL is refused with a 400 and — since the restart's flow is the live one — leaves that
    // flow waiting for its own callback rather than killing it.
    expect((await redirect(stale, { state: stale.searchParams.get('state') as string, code: 'c' })).status).toBe(400);
    const waiting = await runLogin(d);
    expect(waiting).toMatch(/still waiting/i);
    expect(authorizationUrl(waiting).searchParams.get('state')).toBe(fresh.searchParams.get('state'));
  });

  it('leaves no handle that could keep the process alive', async () => {
    const port = await freePort();
    const realSetTimeout = globalThis.setTimeout;
    const timers: NodeJS.Timeout[] = [];
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const timer = realSetTimeout(fn, ms);
      timers.push(timer);
      return timer;
    }) as unknown as typeof setTimeout);

    const d = deps(port, {
      callbackTimeoutMs: 60_000,
      exchange: async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }),
    });
    const url = authorizationUrl(await runLogin(d));
    spy.mockRestore();

    // The flow owns exactly one timer, and it is unref'd: a minute-long authorization window must
    // never be the reason the host process refuses to exit.
    expect(timers).toHaveLength(1);
    expect(timers[0].hasRef()).toBe(false);

    await redirect(url, { state: url.searchParams.get('state') as string, code: 'c' });
    await runLogin(d);

    expect(timers[0].hasRef()).toBe(false);
    await rebind(port);
  });
});
