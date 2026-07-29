import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../src/client/rate-limiter.js';

// HARDENING REGRESSION — the slot reservation (`nextAvailableAt = waitUntil + interval`)
// now happens SYNCHRONOUSLY before the `await sleepFn(delay)`, so concurrent callers each
// reserve a distinct, staggered slot instead of collapsing onto one. This prevents an
// N-wide burst past the account limit the moment a paginator or bulk tool parallelises
// requests. (Was previously pinned to the buggy collapsed schedule.)
describe('RateLimiter — concurrent acquire (staggered)', () => {
  it('staggers concurrent acquisitions onto distinct slots instead of collapsing them', async () => {
    let now = 1000;
    const delays: number[] = [];
    // Yield to the microtask queue so all five acquire() bodies run before any resolves.
    const sleep = (ms: number) => {
      delays.push(ms);
      return new Promise<void>((resolve) => setTimeout(resolve, 0));
    };
    const rl = new RateLimiter({ requestsPerMinute: 60, now: () => now, sleep }); // 1000ms spacing

    await Promise.all([rl.acquire(), rl.acquire(), rl.acquire(), rl.acquire(), rl.acquire()]);

    // First caller fires immediately (delay 0, no sleep); the remaining four wait strictly
    // increasing amounts so they land at t=2000/3000/4000/5000 — one request per slot.
    expect(delays).toEqual([1000, 2000, 3000, 4000]);
  });
});
