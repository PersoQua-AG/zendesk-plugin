import { describe, it, expect } from 'vitest';
import { runLogin, type LoginDeps } from '../../src/tools/login.js';
import type { CallbackListener } from '../../src/auth/oauth-flow.js';
import { authorizationUrl, deps, freePort, rebind, redirect, setupLoginHarness } from './login-harness.js';

// runLogin hangs every call behind the one before it (src/tools/login.ts:205-209). The queue is the
// only reason an overlapping call collects the running flow instead of binding a rival listener on
// the same port — but a queue is also a new failure surface, and these are the interleavings the
// two-call battery does not reach: three at once, one arriving mid-EXCHANGE, one arriving with a
// force, and one arriving after a call that threw.
setupLoginHarness('login-queue-');

// Whatever an overlapping call answers, it must never be the advice that would destroy the live
// flow: close the process on the port, or change oauth_callback_port and restart the extension.
function expectNoPortBlame(text: string): void {
  expect(text, `the overlapping call blamed the port:\n${text}`).not.toContain('Close whatever is listening');
  expect(text).not.toContain('oauth_callback_port');
  expect(text).not.toMatch(/restart the extension/i);
}

describe('overlapping zendesk_login calls', () => {
  it('lets exactly one of three simultaneous calls start the flow, and answers the others from it', async () => {
    const port = freePort();
    const d = deps(port, { callbackTimeoutMs: 60_000 });

    const texts = await Promise.all([runLogin(d), runLogin(d), runLogin(d)]);
    const started = texts.filter((t) => /authorization started/i.test(t));
    expect(started, `not exactly one call started a flow:\n${texts.join('\n---\n')}`).toHaveLength(1);

    const live = authorizationUrl(started[0]);
    for (const text of texts) {
      expectNoPortBlame(text);
      // Every reply points at the ONE live authorization — same state, same challenge.
      expect(authorizationUrl(text).toString()).toBe(live.toString());
    }

    // And only one listener was ever bound: the live state is accepted, and the port is then free.
    expect((await redirect(live, { state: live.searchParams.get('state') as string, code: 'c' })).status).toBe(200);
    await rebind(port);
  });

  it('answers a call that arrives while the token exchange is in flight from the finished flow', async () => {
    const port = freePort();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inExchange = new Promise<void>((r) => (entered = r));
    const d = deps(port, {
      callbackTimeoutMs: 60_000,
      exchange: async () => {
        entered();
        await gate;
        return { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 };
      },
    });

    const url = authorizationUrl(await runLogin(d));
    await redirect(url, { state: url.searchParams.get('state') as string, code: 'c' });

    const collecting = runLogin(d); // enters collectFlow and parks in the exchange
    await inExchange;
    const overlapping = runLogin(d); // arrives while the POST to Zendesk is still open
    release();

    expect(await collecting).toMatch(/authorization complete/i);
    // The overlapping call must not re-enter the flow that is already being exchanged (a code
    // cannot be replayed) and must not start a rival one: it sees the credentials that just landed.
    const text = await overlapping;
    expectNoPortBlame(text);
    expect(text).toMatch(/already authorized/i);
    await rebind(port);
  });

  it('does not blame the port when a call overlaps a force restart', async () => {
    const port = freePort();
    const d = deps(port, { callbackTimeoutMs: 60_000 });
    const stale = authorizationUrl(await runLogin(d));

    const [forced, overlapping] = await Promise.all([runLogin(d, { force: true }), runLogin(d)]);
    const fresh = authorizationUrl(forced);
    expect(fresh.searchParams.get('state')).not.toBe(stale.searchParams.get('state'));

    expectNoPortBlame(overlapping);
    // force closes the old listener and binds a new one on the SAME port; the overlapping call must
    // land on the new flow, never on the abandoned state it would have been given a moment earlier.
    expect(authorizationUrl(overlapping).toString()).toBe(fresh.toString());
    expect((await redirect(fresh, { state: fresh.searchParams.get('state') as string, code: 'c' })).status).toBe(200);
    await rebind(port);
  });

  // A failing exchange must RELEASE the queue, not hold it: the flow is dropped, the port is freed
  // and the very next call starts over. Before the queue every call was independent, so nothing
  // pinned that a failed step lets the following one through at all.
  it('releases the queue when the exchange fails, so the next login starts a fresh flow', async () => {
    const port = freePort();
    const arrived: NonNullable<LoginDeps['listen']> = async (): Promise<CallbackListener> => ({
      promise: Promise.resolve({ code: 'c', redirectUri: `http://localhost:${port}/callback` }),
      close: () => {},
    });
    const d = deps(port, {
      listen: arrived,
      exchange: async () => {
        throw new Error('Token exchange failed: 400 invalid_grant');
      },
    });
    const stale = authorizationUrl(await runLogin(d));

    const [failed, following] = await Promise.all([runLogin(d), runLogin(d)]);
    expect(failed).toMatch(/invalid_grant/);
    expect(failed).toContain('start a new authorization');
    // The call queued behind the failure is not answered with the dead flow, and not with an error
    // that belongs to the call before it.
    expectNoPortBlame(following);
    expect(following).toMatch(/authorization started/i);
    expect(authorizationUrl(following).searchParams.get('state')).not.toBe(stale.searchParams.get('state'));
  });
});
