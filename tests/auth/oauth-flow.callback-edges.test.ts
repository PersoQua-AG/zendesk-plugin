import { describe, it, expect, afterEach } from 'vitest';
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
