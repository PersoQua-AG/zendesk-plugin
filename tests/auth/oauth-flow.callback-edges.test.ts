import { describe, it, expect, afterEach, vi } from 'vitest';
import { startCallbackListener } from '../../src/auth/oauth-flow.js';
import { answerFromOurListener, closeRawSockets, freePort, settlesWithin } from './login-harness.js';

// Two edges of the callback listener's rejection text, which reaches the model as tool output.
afterEach(closeRawSockets);

// The clock is FAKED, and advanced by this function after every target has been answered.
//
// Two of the cases below assert on a note the timeout message carries only if the stray callback
// was handled before the timer fired, and they used to give the listener 200 ms of real wall clock
// to manage it in. That is a race, not a property: the request has to arrive, be parsed and be
// answered inside the very budget the timer is counting down. Measured in the PR #42 review, a
// 250 ms stall ahead of the stray callback turned both red on a machine that was merely busy. The
// ordering is structural now — nothing but the advance below moves the timer, so no wall-clock
// delay can reach it. The 200 ms is unchanged: raising it moves the race rather than removing it.
//
// Only setTimeout/clearTimeout are faked, so the sockets stay on the real event loop. The
// watchdogs in settlesWithin are built on a setTimeout captured at module load (login-harness.ts),
// precisely so that faking the clock here cannot disarm them: a hung exchange still fails with the
// label that names which call hung.
async function rejectionAfter(targets: string[], timeoutMs: number): Promise<string> {
  const port = freePort();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const listener = await startCallbackListener(port, 'state-abc', timeoutMs);
    const message = settlesWithin('the listener', listener.promise).then(
      () => 'resolved, but a rejection was expected',
      (err: Error) => err.message,
    );
    try {
      for (const target of targets) await answerFromOurListener(port, target);
      // THE TIMER IS ADVANCED HERE, and nowhere else — after every target above has been answered.
      await vi.advanceTimersByTimeAsync(timeoutMs);
      return await message;
    } finally {
      listener.close();
    }
  } finally {
    vi.useRealTimers();
  }
}

describe('an error code carrying angle brackets (#11 point 16)', () => {
  it.each([
    ['%3Cx%3E', 'x'],
  ])('drops them from `%s`', async (raw, expected) => {
    const message = await rejectionAfter([`/callback?state=state-abc&error=${raw}`], 60_000);
    expect(message).toBe(`OAuth authorization failed: ${expected}`);
  });
});

describe('the timeout after a callback with an unexpected state (#11 point 17)', () => {
  it('names that such a callback was ignored, without its state value', async () => {
    const message = await rejectionAfter(['/callback?state=WRONG-STATE-VALUE&code=c'], 200);
    expect(message).toBe(
      'OAuth callback timed out after 200ms; a callback with an unexpected state was received and ignored',
    );
  });

  it('counts a callback with no state at all as unexpected too', async () => {
    const message = await rejectionAfter(['/callback?code=c'], 200);
    expect(message).toMatch(/unexpected state was received and ignored$/);
  });

  it('keeps the plain timeout wording when no such callback arrived', async () => {
    expect(await rejectionAfter([], 200)).toBe('OAuth callback timed out after 200ms');
  });
});
