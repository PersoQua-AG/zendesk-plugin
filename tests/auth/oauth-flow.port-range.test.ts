import { describe, it, expect } from 'vitest';
import { startCallbackListener, waitForAuthorizationCode } from '../../src/auth/oauth-flow.js';
import { settlesWithin } from './login-harness.js';

// server.listen() validates its port SYNCHRONOUSLY and throws a RangeError. That throw is never
// delivered as an 'error' event, so the listener's error handler cannot see it — and while listen()
// stood inside the INNER promise executor, the throw only rejected that inner promise, which the
// `promise.catch(() => {})` guarding against unhandled rejections swallowed: the outer promise
// stayed pending forever. A never-settling bind is the worst shape this can take — the caller has
// no error, no timeout and no listener, and the login queue behind it never moves again.
//
// listen() now stands in the OUTER executor, so a synchronous throw rejects the returned promise by
// Promise semantics. This file is about the WORDING the caller then gets; the liveness invariant
// itself — that every port value settles, whatever the value — lives in oauth-flow.bind-liveness,
// and so does the asynchronous EADDRINUSE half of it (:113).
const SYNCHRONOUSLY_REJECTED = [
  ['above the maximum port', 70_000],
  ['one past the maximum port', 65_536],
  ['negative', -1],
  ['not a whole number', 8976.5],
] as const;

describe('startCallbackListener with an unusable port', () => {
  it.each(SYNCHRONOUSLY_REJECTED)('settles — never hangs — when the port is %s', async (_label, port) => {
    await expect(
      settlesWithin(`startCallbackListener(${port})`, startCallbackListener(port, 'state', 5_000)),
    ).rejects.toThrow(/OAuth callback server could not start on port/);
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
});
