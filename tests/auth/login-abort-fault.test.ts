import { describe, it, expect } from 'vitest';
import { runLogin } from '../../src/tools/login.js';
import type { CallbackListener } from '../../src/auth/oauth-flow.js';
import { deps, freePort, setupLoginHarness } from './login-harness.js';

// A close() that throws is unreachable with the real listener (#11 point 2), so it is injected here.
// It is also the one fault that makes a queued login REJECT, which is what proves the queue's
// reject arm (src/tools/login.ts runLogin) is load-bearing rather than dead (#11 point 6).
setupLoginHarness('login-abort-fault-');

function listenerWhoseCloseThrowsOnce(): (port: number, state: string, timeoutMs: number) => Promise<CallbackListener> {
  let calls = 0;
  return async () => {
    calls += 1;
    const faulty = calls === 1;
    return {
      promise: new Promise<never>(() => {}),
      close: () => {
        if (faulty) throw new Error('injected close fault');
      },
    };
  };
}

describe('a flow whose listener close() throws', () => {
  it('is still forgotten, so the next zendesk_login starts a fresh authorization', async () => {
    const d = deps(freePort(), { callbackTimeoutMs: 60_000, listen: listenerWhoseCloseThrowsOnce() });

    expect(await runLogin(d)).toMatch(/authorization started/i);
    await expect(runLogin(d, { force: true })).rejects.toThrow('injected close fault');
    expect(await runLogin(d)).toMatch(/authorization started/i);
  });
});
