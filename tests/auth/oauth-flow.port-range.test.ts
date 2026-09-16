import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startCallbackListener, waitForAuthorizationCode } from '../../src/auth/oauth-flow.js';

// server.listen() validates its port SYNCHRONOUSLY and throws a RangeError. That throw is never
// delivered as an 'error' event, so the listener's error handler cannot see it — and inside the
// inner promise executor it was swallowed by the `promise.catch(() => {})` that guards against
// unhandled rejections, leaving the outer promise pending forever (src/auth/oauth-flow.ts).
// A never-settling bind is the worst shape this can take: the caller has no error, no timeout and
// no listener, and the login queue behind it never moves again.
const SYNCHRONOUSLY_REJECTED = [
  ['above the maximum port', 70_000],
  ['one past the maximum port', 65_536],
  ['negative', -1],
  ['not a whole number', 8976.5],
] as const;

// Fails loudly instead of hanging until the suite timeout: a pending promise IS the defect.
function settlesWithin<T>(label: string, promise: Promise<T>, ms = 2_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} never settled within ${ms}ms`)), ms);
      t.unref?.();
    }),
  ]);
}

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

// A bind can fail in exactly two ways, and they arrive through different channels: the port value is
// rejected SYNCHRONOUSLY by listen(), or the OS refuses the bind ASYNCHRONOUSLY via an 'error' event
// (EADDRINUSE). Both have to settle the outer promise — that is the whole contract
// startCallbackListener() offers its callers, and the login queue depends on it holding for both.
describe('startCallbackListener settles on every bind failure', () => {
  it('rejects on a synchronous port rejection and on an asynchronous EADDRINUSE alike', async () => {
    const taken: Server = await new Promise((resolve) => {
      const s = createServer(() => {});
      s.listen(0, () => resolve(s));
    });
    const takenPort = (taken.address() as { port: number }).port;
    try {
      const outcomes = await settlesWithin(
        'both bind failures',
        Promise.allSettled([
          startCallbackListener(70_000, 'state', 5_000),
          startCallbackListener(takenPort, 'state', 5_000),
        ]),
      );
      expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    } finally {
      await new Promise<void>((r) => taken.close(() => r()));
    }
  });
});
