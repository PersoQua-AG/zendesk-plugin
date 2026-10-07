import { describe, it, expect, afterEach, vi } from 'vitest';
import { startCallbackListener } from '../../src/auth/oauth-flow.js';
import { answerFromOurListener, closeRawSockets, freePort, settlesWithin } from './login-harness.js';

// Two edges of the callback listener's rejection text, which reaches the model as tool output.
afterEach(closeRawSockets);

async function rejectionAfter(targets: string[], timeoutMs: number): Promise<string> {
  const port = freePort();
  const listener = await startCallbackListener(port, 'state-abc', timeoutMs);
  const message = settlesWithin('the listener', listener.promise).then(
    () => 'resolved, but a rejection was expected',
    (err: Error) => err.message,
  );
  try {
    for (const target of targets) await answerFromOurListener(port, target);
    return await message;
  } finally {
    listener.close();
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

// The two cases below assert on a note the timeout message carries ONLY if the stray callback was
// handled first. Under a real 200 ms clock that is a race, not a property: the request has to
// reach the listener, be parsed and be answered inside the same budget the timer is counting down.
// Measured in the PR #42 review, a 250 ms stall ahead of the stray callback turned both red on a
// machine that was merely busy.
//
// So the clock is faked and the timer is advanced BY THIS TEST, on the line marked below, after
// `answerFromOurListener` has returned for every target. The ordering is then structural: no
// amount of wall-clock delay can move the timer, because nothing but that line moves it. The
// 200 ms stays as it is — raising it moves the race, it does not remove it.
//
// Only setTimeout/clearTimeout are faked. The sockets still run on the real event loop, and
// `settlesWithin`'s own 2 s watchdog is left standing: advancing by 200 ms cannot reach it, so a
// listener that genuinely hangs still fails loudly rather than waiting out the suite timeout.
async function rejectionAfterStray(targets: string[], timeoutMs: number): Promise<string> {
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
      // THE TIMER IS ADVANCED HERE, and nowhere else — after every stray callback above has been
      // answered. This line is the fix for #49.
      await vi.advanceTimersByTimeAsync(timeoutMs);
      return await message;
    } finally {
      listener.close();
    }
  } finally {
    vi.useRealTimers();
  }
}

describe('the timeout after a callback with an unexpected state (#11 point 17)', () => {
  it('names that such a callback was ignored, without its state value', async () => {
    const message = await rejectionAfterStray(['/callback?state=WRONG-STATE-VALUE&code=c'], 200);
    expect(message).toBe(
      'OAuth callback timed out after 200ms; a callback with an unexpected state was received and ignored',
    );
  });

  it('counts a callback with no state at all as unexpected too', async () => {
    const message = await rejectionAfterStray(['/callback?code=c'], 200);
    expect(message).toMatch(/unexpected state was received and ignored$/);
  });

  it('keeps the plain timeout wording when no such callback arrived', async () => {
    expect(await rejectionAfter([], 200)).toBe('OAuth callback timed out after 200ms');
  });
});
