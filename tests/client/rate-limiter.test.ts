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
    function steppedLimiter() {
      let now = 1_000_000;
      const sleep = vi.fn().mockImplementation(async (ms: number) => {
        now += ms;
      });
      return { limiter: new RateLimiter({ requestsPerMinute: 400, now: () => now, sleep }), sleep };
    }

    it.each([
      ['a 23-day value', 2_000_000],
      ['a value beyond 2^31 ms', 3_000_000],
      ['Infinity', Infinity],
      ['NaN', NaN],
    ])('waits at most 300 s for %s', async (_label, seconds) => {
      const { limiter, sleep } = steppedLimiter();
      await limiter.acquire();
      limiter.reportRetryAfter(seconds);
      await limiter.acquire();
      expect(sleep).toHaveBeenLastCalledWith(300_000);
      await limiter.acquire();
      expect(sleep).toHaveBeenLastCalledWith(150);
    });

    it('leaves a value at the cap unchanged', async () => {
      const { limiter, sleep } = steppedLimiter();
      await limiter.acquire();
      limiter.reportRetryAfter(300);
      await limiter.acquire();
      expect(sleep).toHaveBeenLastCalledWith(300_000);
    });

    it.each([0, -5])('adds no wait for %s', async (seconds) => {
      const { limiter, sleep } = steppedLimiter();
      await limiter.acquire();
      limiter.reportRetryAfter(seconds);
      await limiter.acquire();
      expect(sleep).toHaveBeenLastCalledWith(150);
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
        expect(released).toBe(true);
      });
    });
  });
});
