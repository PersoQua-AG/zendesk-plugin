import { describe, it, expect, vi } from 'vitest';
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
});
