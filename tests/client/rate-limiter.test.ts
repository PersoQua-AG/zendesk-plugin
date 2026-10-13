import { describe, it, expect, vi, afterEach } from 'vitest';
import { RateLimiter } from '../../src/client/rate-limiter.js';

describe('RateLimiter', () => {
  it('does not delay the first request', async () => {
    let now = 1_000_000;
    const sleep = vi.fn().mockResolvedValue(undefined);
    const limiter = new RateLimiter({ requestsPerMinute: 400, now: () => now, sleep });
    await limiter.acquire();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('spaces requests to respect requests-per-minute', async () => {
    let now = 1_000_000;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      now += ms;
    });
    // 400 req/min => 150ms between requests
    const limiter = new RateLimiter({ requestsPerMinute: 400, now: () => now, sleep });
    await limiter.acquire();
    await limiter.acquire();
    expect(sleep).toHaveBeenCalledWith(150);
  });

  it('honors a reported Retry-After window before the next acquire', async () => {
    let now = 1_000_000;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      now += ms;
    });
    const limiter = new RateLimiter({ requestsPerMinute: 400, now: () => now, sleep });
    await limiter.acquire();
    limiter.reportRetryAfter(5); // 5 seconds
    await limiter.acquire();
    expect(sleep).toHaveBeenLastCalledWith(5000);
  });

  describe('Retry-After cap', () => {
    const SLOT_MS = 60_000 / 400;

    function steppedLimiter() {
      let now = 1_000_000;
      const sleep = vi.fn().mockImplementation(async (ms: number) => {
        now += ms;
      });
      return {
        limiter: new RateLimiter({ requestsPerMinute: 400, now: () => now, sleep }),
        sleep,
        advance: (ms: number) => {
          now += ms;
        },
      };
    }

    it.each([
      ['a 23-day value', 2_000_000],
      ['Infinity', Infinity],
      ['NaN', NaN],
    ])('waits at most 300 s for %s', async (_label, seconds) => {
      const { limiter, sleep } = steppedLimiter();
      await limiter.acquire();
      limiter.reportRetryAfter(seconds);
      await limiter.acquire();
      expect(sleep).toHaveBeenLastCalledWith(300_000);
      await limiter.acquire();
      expect(sleep).toHaveBeenLastCalledWith(SLOT_MS);
    });

    // #53: a second 429 arriving with a shorter header must not reopen a window Zendesk
    // still holds shut, so the window extends and never contracts.
    it('does not let a shorter later window shorten an active one', async () => {
      const { limiter, sleep, advance } = steppedLimiter();
      limiter.reportRetryAfter(120);
      advance(1_000);
      limiter.reportRetryAfter(5); // would have ended 114 s earlier
      advance(1_000);
      await limiter.acquire();
      expect(sleep).toHaveBeenCalledWith(118_000);
    });

    // Regression guard, not an ablating test: a plain assignment passes this too.
    it('still extends when the later window is longer', async () => {
      const { limiter, sleep, advance } = steppedLimiter();
      limiter.reportRetryAfter(5);
      advance(1_000);
      limiter.reportRetryAfter(120);
      await limiter.acquire();
      expect(sleep).toHaveBeenCalledWith(120_000);
    });

    it.each([0, -5])('adds no wait for %s', async (seconds) => {
      const { limiter, sleep } = steppedLimiter();
      await limiter.acquire();
      limiter.reportRetryAfter(seconds);
      await limiter.acquire();
      expect(sleep).toHaveBeenLastCalledWith(SLOT_MS);
    });

    describe('with the default timer', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it('still holds the next request after a value beyond 2^31 ms', async () => {
        vi.useFakeTimers();
        const limiter = new RateLimiter({ requestsPerMinute: 400 });
        await limiter.acquire();
        limiter.reportRetryAfter(3_000_000);
        let released = false;
        const pending = limiter.acquire().then(() => {
          released = true;
        });
        await vi.advanceTimersByTimeAsync(299_999);
        expect(released).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await pending;
      });
    });
  });
});
