// The token POST is the one step in the login flow that had no bound of its own. A Zendesk that
// accepts the connection and then says nothing parked it for undici's headersTimeout (~300 s), and
// because runLogin queues every call (src/tools/login.ts:205-209), that park silenced zendesk_login
// process-wide — force=true included, because abortLoginFlow does not reach into the queue.
// These cases pin the bound, the prose it produces, and that the queue is free again afterwards.
import { describe, it, expect } from 'vitest';
import { exchangeCodeForTokens, refreshAccessToken } from '../../src/auth/oauth-flow.js';
import { runLogin, type LoginDeps } from '../../src/tools/login.js';
import type { CallbackListener } from '../../src/auth/oauth-flow.js';
import { authorizationUrl, config, deps, freePort, setupLoginHarness } from './login-harness.js';

setupLoginHarness('login-timeout-');

const PORT = 18977;
const REDIRECT = `http://localhost:${PORT}/callback`;

// What undici rejects with once AbortSignal.timeout fires: the signal's reason, verbatim.
function timingOutFetch(): typeof fetch {
  return (() =>
    Promise.reject(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    )) as unknown as typeof fetch;
}

function capturingFetch(seen: RequestInit[]): typeof fetch {
  return ((_input: unknown, init: RequestInit) => {
    seen.push(init);
    return Promise.resolve(
      new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
}

describe('token request timeout', () => {
  it('sends the authorization-code exchange with a live timeout signal', async () => {
    const seen: RequestInit[] = [];
    await exchangeCodeForTokens(config(PORT), 'c', 'v', REDIRECT, capturingFetch(seen));

    expect(seen).toHaveLength(1);
    const signal = seen[0].signal;
    expect(signal, 'the token POST carries no AbortSignal — its wait is inherited, not chosen').toBeInstanceOf(
      AbortSignal,
    );
    expect((signal as AbortSignal).aborted).toBe(false);
  });

  // The refresh runs unattended before every API call, so an unbounded hang there stalls the whole
  // server rather than one login. It goes through the same POST deliberately, and gets the same bound.
  it('sends the refresh with the same timeout signal', async () => {
    const seen: RequestInit[] = [];
    await refreshAccessToken(config(PORT), 'refresh-token', capturingFetch(seen));

    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('turns a timed-out exchange into prose that names the bound and a remedy', async () => {
    await expect(
      exchangeCodeForTokens(config(PORT), 'c', 'v', REDIRECT, timingOutFetch()),
    ).rejects.toThrow(/Token exchange failed: no reply from the Zendesk token endpoint within 30 seconds/);
  });

  it('turns a timed-out refresh into the same prose under its own label', async () => {
    await expect(refreshAccessToken(config(PORT), 'refresh-token', timingOutFetch())).rejects.toThrow(
      /Token refresh failed: no reply from the Zendesk token endpoint within 30 seconds/,
    );
  });

  it('passes a non-timeout transport failure through untouched', async () => {
    const failing = (() => Promise.reject(new Error('getaddrinfo ENOTFOUND acme.zendesk.com'))) as unknown as typeof fetch;
    await expect(exchangeCodeForTokens(config(PORT), 'c', 'v', REDIRECT, failing)).rejects.toThrow(
      'getaddrinfo ENOTFOUND acme.zendesk.com',
    );
  });

  it('answers the user with instructions and leaves the login queue free for the next call', async () => {
    const port = await freePort();
    const arrived: NonNullable<LoginDeps['listen']> = async (): Promise<CallbackListener> => ({
      promise: Promise.resolve({ code: 'c', redirectUri: `http://localhost:${port}/callback` }),
      close: () => {},
    });
    const d = deps(port, {
      listen: arrived,
      // The real exchange, driven by a fetch that does what a timed-out POST does.
      exchange: (cfg, code, verifier, uri) => exchangeCodeForTokens(cfg, code, verifier, uri, timingOutFetch()),
    });

    const stale = authorizationUrl(await runLogin(d));
    const timedOut = await runLogin(d);

    // Handling instructions, not machinery: no stack, no path, no raw abort prose.
    expect(timedOut).toContain('no reply from the Zendesk token endpoint within 30 seconds');
    expect(timedOut).toContain('check the network connection');
    expect(timedOut).toContain('Run zendesk_login again to start a new authorization.');
    expect(timedOut).not.toMatch(/abort/i);
    expect(timedOut).not.toMatch(/\n\s+at /);
    expect(timedOut).not.toContain(d.tokensPath);

    // And the queue is not held by the abandoned exchange: the next login starts a fresh flow.
    const following = await runLogin(d);
    expect(following).toMatch(/authorization started/i);
    expect(authorizationUrl(following).searchParams.get('state')).not.toBe(stale.searchParams.get('state'));
  });
});
