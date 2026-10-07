import { describe, it, expect, vi } from 'vitest';
import { settlesWithin } from './login-harness.js';

// The one pin for the real-clock capture in login-harness.ts. Built on the global `setTimeout`,
// the watchdog could only fire if the test advanced the faked clock — and a test waiting on a hung
// call is by definition not advancing it.
//
// THE RACE IS THE ASSERTION, not vitest's timeout. Written as a plain `rejects.toThrow()`, the
// ablated version does not fail, it HANGS, and dies on "Test timed out in 5000ms" — which names
// nothing and is exactly the failure mode this helper exists to replace. So a real timer, captured
// before the fake clock is installed, races the watchdog and the outcome is compared as a string.
const realSetTimeout = globalThis.setTimeout;

describe('settlesWithin under a faked clock', () => {
  it('still fires its watchdog, with its label, while the test never advances the clock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const never = new Promise<string>(() => {});
      const outcome = await Promise.race([
        settlesWithin('the hung call', never, 300).then(
          () => 'it resolved',
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        ),
        new Promise<string>((r) => {
          realSetTimeout(() => r('the watchdog never fired: it is armed on the faked clock'), 2_000).unref?.();
        }),
      ]);
      expect(outcome).toBe('the hung call never settled within 300ms');
    } finally {
      vi.useRealTimers();
    }
  });
});
