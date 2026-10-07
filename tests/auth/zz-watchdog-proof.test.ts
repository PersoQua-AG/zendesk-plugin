import { describe, it, expect, vi } from 'vitest';
import { settlesWithin } from './login-harness.js';

describe('PROOF ONLY — settlesWithin under a faked clock', () => {
  it('still fires its watchdog, with its label, while the test never advances the clock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const hung = new Promise<string>(() => {});
      await expect(settlesWithin('the hung call', hung, 300)).rejects.toThrow(
        'the hung call never settled within 300ms',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
