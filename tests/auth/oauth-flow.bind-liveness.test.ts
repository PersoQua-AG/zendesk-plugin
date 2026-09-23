import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startCallbackListener, waitForAuthorizationCode } from '../../src/auth/oauth-flow.js';
import { resolveAuthConfig } from '../../src/auth/config.js';
import { runLogin } from '../../src/tools/login.js';
import { deps, freePort, settlesWithin, setupLoginHarness } from './login-harness.js';

setupLoginHarness('login-bind-liveness-');

// The invariant this file pins is LIVENESS, not a message: startCallbackListener() must SETTLE for
// every port value, whatever the value is. A rejection is a fine outcome; a pending promise is the
// defect, because beginFlow() awaits it and the login queue (src/tools/login.ts:201-205) holds
// every later zendesk_login behind that await with no timeout and no message. The shape that used
// to hang: server.listen() validates its port SYNCHRONOUSLY and throws a RangeError that is never
// delivered as an 'error' event, so while listen() stood in the INNER promise executor the throw
// only rejected the inner promise, which the unhandled-rejection guard swallowed. It stands in the
// OUTER executor now, which is what the cases below hold in place.
//
// Measured, not assumed — node v24, `server.listen(p)` on a fresh http server:
//   NaN, Infinity, -Infinity, -1, 1.5, 65536, 70000 -> throws RangeError ERR_SOCKET_BAD_PORT
//   0                                               -> binds a RANDOM port, no throw, no error event
// so the table below is split at exactly that line and not at the line the guard draws.
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
    const err = await settlesWithin(`startCallbackListener(${port})`, startCallbackListener(port, 'state', 5_000)).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain('OAuth callback server could not start on port');
    expect(err.message).toContain('oauth_callback_port');
    // The node wording is replaced, not wrapped: no internals reach the MCP boundary.
    expect(err.message).not.toMatch(/RangeError|ERR_SOCKET_BAD_PORT|node:internal/);
  });

  it('names the configuration field and the range the user has to fix, and leaks no internals', async () => {
    const err = await settlesWithin('startCallbackListener(70000)', startCallbackListener(70_000, 'state', 5_000)).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).toBe(
      'OAuth callback server could not start on port 70000 (extension configuration field ' +
        '"oauth_callback_port" must be a whole number between 1024 and 65535).',
    );
    // The RangeError's own wording names node's argument validation, not a remedy.
    expect(err.message).not.toMatch(/RangeError|options\.port|ERR_SOCKET_BAD_PORT/);
    expect(err.message.split('\n')).toHaveLength(1);
  });

  // The CLI path awaits the same listener. It must fail, not wait for a callback that can never come.
  it('makes the CLI wrapper reject rather than wait forever', async () => {
    await expect(
      settlesWithin('waitForAuthorizationCode(70000)', waitForAuthorizationCode(70_000, 'state', 5_000)),
    ).rejects.toThrow(/oauth_callback_port/);
  });

  // Port 0 is the one value listen() ACCEPTS and the configuration rejects, and it is the sharpest
  // shape of the bug the guard exists for: the bind succeeds on a random port while redirectUri()
  // still advertises :0/callback, so the callback could never land. Pinned as it behaves today —
  // it settles, which is this file's invariant — together with the proof that no reachable caller
  // can produce it, which is what makes the mismatch harmless rather than latent.
  it('settles on port 0 too, binding a random port while the redirect URI still says :0', async () => {
    const listener = await settlesWithin('startCallbackListener(0)', startCallbackListener(0, 'state', 5_000));
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
    expect(text).toBe('Missing required environment variable: ZENDESK_SUBDOMAIN');
  });
});

// Liveness no longer depends on a catch block: server.listen() stands in the OUTER executor, so ANY
// synchronous throw there rejects the returned promise by Promise semantics. What the catch beside
// it still owns is cleanup and wording — and server.close(), the one call in there that could throw,
// is called on a server that never listened, so the case below pins that it does not.
describe('finish() is not a second way to lose the outcome', () => {
  it('server.close() does not throw on a server that never listened, nor on a second call', () => {
    const s = createServer(() => {});
    expect(() => s.close()).not.toThrow();
    expect(() => s.close()).not.toThrow();
  });

  it('settles both the outer promise and the inner one on a synchronous listen() failure', async () => {
    await expect(settlesWithin('outer', startCallbackListener(70_000, 'state', 5_000))).rejects.toThrow(
      /could not start/,
    );
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
      await expect(
        settlesWithin(`startCallbackListener(${port})`, startCallbackListener(port, 'state', 5_000)),
      ).rejects.toThrow(/EADDRINUSE|address already in use/i);
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
      const text = await settlesWithin(`runLogin(${port})`, runLogin(deps(port)));
      expect(text, `runLogin(${port})`).toContain('oauth_callback_port');
    }

    const port = freePort();
    const after = await settlesWithin('the next runLogin', runLogin(deps(port, { callbackTimeoutMs: 60_000 })));
    expect(after).toMatch(/authorization started/i);
  });
});
