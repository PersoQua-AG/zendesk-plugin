import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startCallbackListener } from '../../src/auth/oauth-flow.js';
import { resolveAuthConfig } from '../../src/auth/config.js';
import { runLogin } from '../../src/tools/login.js';
import { deps, freePort, setupLoginHarness } from './login-harness.js';

setupLoginHarness('login-bind-liveness-');

// The invariant this file pins is LIVENESS, not a message: startCallbackListener() must SETTLE for
// every port value, whatever the value is. A rejection is a fine outcome; a pending promise is the
// defect, because beginFlow() awaits it and the login queue (src/tools/login.ts:201-205) holds
// every later zendesk_login behind that await with no timeout and no message.
//
// Measured, not assumed — node v24, `server.listen(p)` on a fresh http server:
//   NaN, Infinity, -Infinity, -1, 1.5, 65536, 70000 -> throws RangeError ERR_SOCKET_BAD_PORT
//   0                                               -> binds a RANDOM port, no throw, no error event
// so the table below is split at exactly that line and not at the line the guard draws.
function settlesWithin<T>(label: string, promise: Promise<T>, ms = 2_000): Promise<PromiseSettledResult<T>> {
  return Promise.race([
    promise.then(
      (value) => ({ status: 'fulfilled', value }) as PromiseSettledResult<T>,
      (reason: unknown) => ({ status: 'rejected', reason }) as PromiseSettledResult<T>,
    ),
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} never settled within ${ms}ms`)), ms);
      t.unref?.();
    }),
  ]);
}

const THROWS_SYNCHRONOUSLY: ReadonlyArray<readonly [string, number]> = [
  ['above the maximum', 70_000],
  ['one past the maximum', 65_536],
  ['negative', -1],
  ['not a whole number', 1.5],
  ['NaN — what Number("abc") produces', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
];

describe('startCallbackListener settles for every port listen() refuses', () => {
  it.each(THROWS_SYNCHRONOUSLY)('settles when the port is %s', async (_label, port) => {
    const outcome = await settlesWithin(`startCallbackListener(${port})`, startCallbackListener(port, 'state', 5_000));
    expect(outcome.status).toBe('rejected');
    const err = (outcome as PromiseRejectedResult).reason as Error;
    expect(err.message).toContain('OAuth callback server could not start on port');
    expect(err.message).toContain('oauth_callback_port');
    // The node wording is replaced, not wrapped: no internals reach the MCP boundary.
    expect(err.message).not.toMatch(/RangeError|ERR_SOCKET_BAD_PORT|node:internal/);
  });

  // Port 0 is the one value listen() ACCEPTS and the configuration rejects, and it is the sharpest
  // shape of the bug the guard exists for: the bind succeeds on a random port while redirectUri()
  // still advertises :0/callback, so the callback could never land. Pinned as it behaves today —
  // it settles, which is this file's invariant — together with the proof that no reachable caller
  // can produce it, which is what makes the mismatch harmless rather than latent.
  it('settles on port 0 too, binding a random port while the redirect URI still says :0', async () => {
    const outcome = await settlesWithin('startCallbackListener(0)', startCallbackListener(0, 'state', 5_000));
    expect(outcome.status).toBe('fulfilled');
    const listener = (outcome as PromiseFulfilledResult<{ close: () => void; promise: Promise<unknown> }>).value;
    listener.close();
    await expect(listener.promise).rejects.toThrow(/closed/);
  });

  it('is unreachable with port 0: every producer of callbackPort refuses it first', async () => {
    const base = {
      ZENDESK_SUBDOMAIN: 'acme',
      ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
      ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
    };
    // Producer 1 — resolveAuthConfig (src/auth/config.ts:161), used by the stdio server, the CLI
    // (src/auth/authorize.ts:49) and the remote bridge (src/remote/remote-server.ts:72).
    expect(() => resolveAuthConfig({ ...base, ZENDESK_OAUTH_CALLBACK_PORT: '0' })).toThrow(/oauth_callback_port/);
    // Producer 2 — NO_OAUTH_CONFIG (src/server.ts:101) DOES carry callbackPort 0, but it always
    // travels with configError, which runLogin answers before it reads the port at all
    // (src/tools/login.ts:213). Asserted rather than trusted to the comment beside it.
    const text = await settlesWithin(
      'runLogin(NO_OAUTH_CONFIG)',
      runLogin(deps(0, { configError: 'Missing required environment variable: ZENDESK_SUBDOMAIN' })),
    );
    expect(text.status).toBe('fulfilled');
    expect((text as PromiseFulfilledResult<string>).value).toBe(
      'Missing required environment variable: ZENDESK_SUBDOMAIN',
    );
  });
});

// The fix added a catch block whose body runs finish() and bindFailed(). If anything in THAT body
// could throw, the executor would reject the inner promise — which promise.catch(() => {}) swallows
// (src/auth/oauth-flow.ts:158) — and neither bound nor bindFailed would ever be called: the exact
// wedge the fix removes, reintroduced one line lower. finish() calls clearTimeout(), server.close()
// and the settle callback, so server.close() is the only candidate, and it is called on a server
// that never listened.
describe('the fix did not move the wedge into finish()', () => {
  it('server.close() does not throw on a server that never listened, nor on a second call', () => {
    const s = createServer(() => {});
    expect(() => s.close()).not.toThrow();
    expect(() => s.close()).not.toThrow();
  });

  it('settles both the outer promise and the inner one on a synchronous listen() failure', async () => {
    const outer = await settlesWithin('outer', startCallbackListener(70_000, 'state', 5_000));
    expect(outer.status).toBe('rejected');
    // The inner promise is rejected too — verified through the only handle a caller could hold if
    // the bind had succeeded. Both must be settled, or a later `await listener.promise` would hang.
    const listener = startCallbackListener(70_000, 'state', 5_000);
    await expect(listener).rejects.toThrow(/could not start/);
  });

  // An asynchronous bind failure (EADDRINUSE) runs finish() from the 'error' handler instead, and
  // there the server DID reach a handle. Both routes through finish() have to settle.
  it('settles when the OS refuses the bind asynchronously', async () => {
    const taken: Server = await new Promise((resolve) => {
      const s = createServer(() => {});
      s.listen(0, () => resolve(s));
    });
    const port = (taken.address() as { port: number }).port;
    try {
      const outcome = await settlesWithin(`startCallbackListener(${port})`, startCallbackListener(port, 'state', 5_000));
      expect(outcome.status).toBe('rejected');
      expect(String((outcome as PromiseRejectedResult).reason)).toMatch(/EADDRINUSE|address already in use/i);
    } finally {
      await new Promise<void>((r) => taken.close(() => r()));
    }
  });
});

// The damage the liveness invariant protects, measured across the WHOLE table rather than for one
// value: a wedged queue is not one failed login, it is every login until the extension restarts.
describe('the login queue survives every unusable port in the table', () => {
  it('answers each one and still starts a normal flow afterwards', async () => {
    for (const [, port] of THROWS_SYNCHRONOUSLY) {
      const outcome = await settlesWithin(`runLogin(${port})`, runLogin(deps(port)));
      expect(outcome.status, `runLogin(${port})`).toBe('fulfilled');
      expect((outcome as PromiseFulfilledResult<string>).value).toContain('oauth_callback_port');
    }

    const port = await freePort();
    const after = await settlesWithin('the next runLogin', runLogin(deps(port, { callbackTimeoutMs: 60_000 })));
    expect(after.status).toBe('fulfilled');
    expect((after as PromiseFulfilledResult<string>).value).toMatch(/authorization started/i);
  });
});
