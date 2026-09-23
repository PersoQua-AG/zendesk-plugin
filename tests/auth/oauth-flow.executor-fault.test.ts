import { describe, it, expect, vi, beforeEach } from 'vitest';

// The INNER executor of startCallbackListener() is the seat of the #9 wedge: a synchronous throw in
// there rejects `promise`, which the `.catch(() => {})` two lines below swallows, so the promise the
// caller awaits stays pending forever and the serialized login queue behind it never moves again.
// #9 fixed the one call known to throw (server.listen); this pins the SHAPE — whatever in that body
// throws, startCallbackListener() still settles.
//
// The fault is injected at `server.on`, NOT at createServer, and the difference is the whole point.
// createServer is the first call on that path, so it leaves `server` and `close` unassigned and the
// OUTER executor then throws a TypeError of its own — which settles the promise whatever the inner
// catch does, and the test would be measuring an error message instead of liveness. By `server.on`
// both are assigned, the outer path completes normally, and nothing but the inner catch settles
// anything. Measured: with the catch in place `rejected: INJECTED_AT_ON`, with its settle removed
// `PENDING`.
const fault = { throwOnListenerRegistration: null as Error | null };

vi.mock('node:http', async () => {
  const actual = await vi.importActual<typeof import('node:http')>('node:http');
  return {
    ...actual,
    createServer: (...args: unknown[]) => {
      const server = (actual.createServer as (...a: unknown[]) => Record<string, unknown>)(...args);
      const on = server.on as (...a: unknown[]) => unknown;
      server.on = (...a: unknown[]) => {
        if (fault.throwOnListenerRegistration) throw fault.throwOnListenerRegistration;
        return on.apply(server, a);
      };
      return server;
    },
  };
});

const { startCallbackListener } = await import('../../src/auth/oauth-flow.js');

// Settled-or-not without a wall clock: everything on this path is synchronous, so draining the
// macrotask queue a few times is enough. A timeout here would be a guess about speed; this is not.
async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  let outcome = 'PENDING';
  void promise.then(
    () => (outcome = 'resolved'),
    (err: Error) => (outcome = `rejected: ${err.message}`),
  );
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return outcome;
}

beforeEach(() => {
  fault.throwOnListenerRegistration = null;
});

describe('startCallbackListener — a synchronous fault in the inner executor', () => {
  it('settles instead of hanging when the inner executor throws after the server exists', async () => {
    fault.throwOnListenerRegistration = new Error('INJECTED_AT_ON');
    expect(await outcomeOf(startCallbackListener(0, 'state-x', 50))).toBe(
      'rejected: INJECTED_AT_ON',
    );
  });

  it('converts a non-Error throw rather than passing a lie to the caller', async () => {
    // The catch writes `err instanceof Error ? err : new Error(String(err))`; a bare `err as Error`
    // would hand `failureText` something that is not an Error at all.
    fault.throwOnListenerRegistration = 'plain string throw' as unknown as Error;
    expect(await outcomeOf(startCallbackListener(0, 'state-y', 50))).toBe(
      'rejected: plain string throw',
    );
  });

  it('still works normally once the fault is lifted', async () => {
    const listener = await startCallbackListener(0, 'state-z', 50);
    listener.close();
    await expect(listener.promise).rejects.toThrow('OAuth callback listener closed');
  });
});
