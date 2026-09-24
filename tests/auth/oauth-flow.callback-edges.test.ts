import { describe, it, expect, afterEach } from 'vitest';
import { startCallbackListener } from '../../src/auth/oauth-flow.js';
import { answerFromOurListener, closeRawSockets, freePort, settlesWithin } from './login-harness.js';

// Edges of the callback listener's rejection text, which reaches the model as tool output.
afterEach(closeRawSockets);

async function rejectionAfter(targets: string[], timeoutMs: number): Promise<string> {
  const port = freePort();
  const listener = await startCallbackListener(port, 'state-abc', timeoutMs);
  const message = settlesWithin('the listener', listener.promise).catch((err: Error) => err.message);
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
    ['%3Cscript%3Ealert%3C%2Fscript%3E', 'scriptalert/script'],
  ])('drops them from `%s`', async (raw, expected) => {
    const message = await rejectionAfter([`/callback?state=state-abc&error=${raw}`], 60_000);
    expect(message).toBe(`OAuth authorization failed: ${expected}`);
  });
});
