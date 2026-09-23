import { describe, it, expect, vi, beforeEach } from 'vitest';

// The INNER executor of startCallbackListener() is the seat of the #9 wedge: a synchronous throw in
// there rejects `promise`, which the `.catch(() => {})` two lines below swallows, so the promise the
// caller awaits would stay pending forever and the serialized login queue behind it would never
// move again. #9 fixed the one call that was known to throw (server.listen); this pins the SHAPE —
// whatever in that body throws, startCallbackListener() still settles.
//
// createServer is the fault injection point because it is the first foreign call on that path, and
// because it genuinely can throw: measured, `http.createServer('nope')` is ERR_INVALID_ARG_TYPE and
// `https.createServer({key:'notakey',cert:'notacert'},fn)` is ERR_OSSL_PEM_NO_START_LINE. Reaching
// it needs the module seam — no port value and no socket traffic can produce it.
const fault = { throwOnCreate: null as Error | null };

vi.mock('node:http', async () => {
  const actual = await vi.importActual<typeof import('node:http')>('node:http');
  return {
    ...actual,
    createServer: (...args: unknown[]) => {
      if (fault.throwOnCreate) throw fault.throwOnCreate;
      return (actual.createServer as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const { startCallbackListener } = await import('../../src/auth/oauth-flow.js');

beforeEach(() => {
  fault.throwOnCreate = null;
});

describe('startCallbackListener — a synchronous fault in the inner executor', () => {
  it('rejects instead of hanging when the inner executor throws', async () => {
    fault.throwOnCreate = new TypeError('ERR_INVALID_ARG_TYPE');

    // Liveness is the assertion: a pending promise here is the defect, a rejection is a fine
    // outcome. The race makes "never settles" fail as a test rather than as a timeout.
    const settled = await Promise.race([
      startCallbackListener(0, 'state-x', 50).then(
        () => 'resolved',
        (err: Error) => `rejected: ${err.message}`,
      ),
      new Promise((r) => setTimeout(() => r('PENDING — the #9 wedge is back'), 1000)),
    ]);

    expect(settled).toBe('rejected: ERR_INVALID_ARG_TYPE');
  });

  it('still works normally once the fault is lifted', async () => {
    const listener = await startCallbackListener(0, 'state-y', 50);
    listener.close();
    await expect(listener.promise).rejects.toThrow('OAuth callback listener closed');
  });
});
