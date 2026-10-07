import { describe, it, expect, vi } from 'vitest';
import { mapErrorResponse, ZendeskRateLimitError, MAX_RETRY_AFTER_SECONDS } from '../../src/client/errors.js';
import { RateLimiter } from '../../src/client/rate-limiter.js';

// #53: the Retry-After the user is told to wait and the window the limiter enforces are one value.

async function rateLimitError(retryAfter: string): Promise<ZendeskRateLimitError> {
  const error = await mapErrorResponse(new Response('', { status: 429, headers: { 'Retry-After': retryAfter } }));
  expect(error).toBeInstanceOf(ZendeskRateLimitError);
  return error as ZendeskRateLimitError;
}

describe('Retry-After reported to the caller', () => {
  it('caps an absurd header at the limiter cap', async () => {
    const error = await rateLimitError('2000000');
    expect(error.retryAfterSeconds).toBe(MAX_RETRY_AFTER_SECONDS);
    expect(error.message).toContain(`retry after ${MAX_RETRY_AFTER_SECONDS}s`);
  });

  it('never reports Infinity for a header too long for a double', async () => {
    const error = await rateLimitError('9'.repeat(400));
    expect(error.retryAfterSeconds).toBe(MAX_RETRY_AFTER_SECONDS);
    expect(error.message).not.toContain('Infinity');
  });

  it('caps a far-future HTTP-date the same way', async () => {
    const error = await rateLimitError(new Date(Date.now() + 86_400_000).toUTCString());
    expect(error.retryAfterSeconds).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it('leaves a normal header unchanged', async () => {
    const error = await rateLimitError('30');
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.message).toContain('retry after 30s');
  });
});

describe('RateLimiter.reportRetryAfter', () => {
  it('does not let a shorter later window shorten an active one', async () => {
    let now = 1_000_000;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      now += ms;
    });
    const limiter = new RateLimiter({ requestsPerMinute: 400, now: () => now, sleep });
    limiter.reportRetryAfter(120); // t=0 -> window ends at t=120s
    now += 1_000;
    limiter.reportRetryAfter(5); // t=1s, would have ended at t=6s
    now += 1_000;
    await limiter.acquire(); // t=2s
    expect(sleep).toHaveBeenCalledWith(118_000);
    expect(now).toBe(1_120_000);
  });

  it('still extends when the later window is longer', async () => {
    let now = 1_000_000;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      now += ms;
    });
    const limiter = new RateLimiter({ requestsPerMinute: 400, now: () => now, sleep });
    limiter.reportRetryAfter(5);
    now += 1_000;
    limiter.reportRetryAfter(120);
    await limiter.acquire();
    expect(now).toBe(1_121_000);
  });
});
