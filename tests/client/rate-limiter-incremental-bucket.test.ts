// tests/client/rate-limiter-incremental-bucket.test.ts
// Pins the incremental-export bucket THROTTLE math. incremental-rate-class.test.ts pins that
// incremental requests ROUTE to the incremental limiter; this pins what that limiter actually
// does at its configured 10 req/min (PRD §5 infra 1): 60_000/10 = 6000 ms between acquires, an
// order of magnitude slower than the 400 req/min default bucket (150 ms). Uses an injected
// clock+sleep — deterministic, no wall-clock waiting.
import { describe, it, expect, vi } from 'vitest';
import { RateLimiter } from '../../src/client/rate-limiter.js';

function fakeClock() {
  let now = 1_000_000;
  const sleep = vi.fn().mockImplementation(async (ms: number) => {
    now += ms;
  });
  return { now: () => now, sleep };
}

describe('incremental 10 req/min bucket', () => {
  it('spaces incremental acquires 6000 ms apart (60_000 / 10)', async () => {
    const { now, sleep } = fakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 10, now, sleep });
    await limiter.acquire(); // first is free
    expect(sleep).not.toHaveBeenCalled();
    await limiter.acquire();
    expect(sleep).toHaveBeenLastCalledWith(6000);
    await limiter.acquire();
    expect(sleep).toHaveBeenLastCalledWith(6000);
  });

  it('is 40× slower per request than the default 400 req/min bucket (6000 ms vs 150 ms)', async () => {
    const inc = fakeClock();
    const def = fakeClock();
    const incremental = new RateLimiter({ requestsPerMinute: 10, now: inc.now, sleep: inc.sleep });
    const standard = new RateLimiter({ requestsPerMinute: 400, now: def.now, sleep: def.sleep });
    await incremental.acquire();
    await incremental.acquire();
    await standard.acquire();
    await standard.acquire();
    expect(inc.sleep).toHaveBeenLastCalledWith(6000);
    expect(def.sleep).toHaveBeenLastCalledWith(150);
  });

  it('a reported Retry-After longer than the bucket interval dominates the next acquire', async () => {
    const { now, sleep } = fakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 10, now, sleep });
    await limiter.acquire();
    limiter.reportRetryAfter(30); // 30s > 6s bucket interval
    await limiter.acquire();
    expect(sleep).toHaveBeenLastCalledWith(30_000);
  });
});
