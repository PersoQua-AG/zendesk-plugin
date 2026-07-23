// tests/client/incremental-rate-class.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { RateLimiter } from '../../src/client/rate-limiter.js';
import type { AuthManager } from '../../src/auth/auth-manager.js';

function limiterSpy(): RateLimiter {
  return { acquire: vi.fn().mockResolvedValue(undefined), reportRetryAfter: vi.fn() } as unknown as RateLimiter;
}
function authStub(): AuthManager {
  return { getAccessToken: vi.fn().mockResolvedValue('tok') } as unknown as AuthManager;
}
function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }), headers: new Headers() });
}

describe('incremental rate class', () => {
  it("acquires from the incremental limiter when rateClass is 'incremental'", async () => {
    const rateLimiter = limiterSpy();
    const incrementalRateLimiter = limiterSpy();
    const client = new ZendeskHttpClient({
      subdomain: 'acme', authManager: authStub(), rateLimiter, incrementalRateLimiter, fetchImpl: okFetch(),
    });
    await client.request('/incremental/tickets/cursor.json?start_time=1', {}, { rateClass: 'incremental' });
    expect(incrementalRateLimiter.acquire).toHaveBeenCalledTimes(1);
    expect(rateLimiter.acquire).not.toHaveBeenCalled();
  });

  it("acquires from the default limiter with no options (backward compatible)", async () => {
    const rateLimiter = limiterSpy();
    const incrementalRateLimiter = limiterSpy();
    const client = new ZendeskHttpClient({
      subdomain: 'acme', authManager: authStub(), rateLimiter, incrementalRateLimiter, fetchImpl: okFetch(),
    });
    await client.request('/tickets.json');
    expect(rateLimiter.acquire).toHaveBeenCalledTimes(1);
    expect(incrementalRateLimiter.acquire).not.toHaveBeenCalled();
  });

  it("falls back to the default limiter for 'incremental' when none is configured", async () => {
    const rateLimiter = limiterSpy();
    const client = new ZendeskHttpClient({ subdomain: 'acme', authManager: authStub(), rateLimiter, fetchImpl: okFetch() });
    await client.request('/incremental/tickets/cursor.json?start_time=1', {}, { rateClass: 'incremental' });
    expect(rateLimiter.acquire).toHaveBeenCalledTimes(1);
  });

  it('reports Retry-After to the SAME limiter it acquired from on a 429', async () => {
    const rateLimiter = limiterSpy();
    const incrementalRateLimiter = limiterSpy();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'slow down', headers: new Headers({ 'retry-after': '7' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }), headers: new Headers() });
    const client = new ZendeskHttpClient({
      subdomain: 'acme', authManager: authStub(), rateLimiter, incrementalRateLimiter, fetchImpl,
    });
    await client.request('/incremental/users/cursor.json?start_time=1', {}, { rateClass: 'incremental' });
    expect(incrementalRateLimiter.reportRetryAfter).toHaveBeenCalledWith(7);
    expect(rateLimiter.reportRetryAfter).not.toHaveBeenCalled();
  });
});
