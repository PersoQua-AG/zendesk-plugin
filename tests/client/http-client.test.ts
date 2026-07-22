import { describe, it, expect, vi } from 'vitest';
import { ZendeskHttpClient } from '../../src/client/http-client.js';
import { ZendeskRateLimitError } from '../../src/client/errors.js';
import type { RateLimiter } from '../../src/client/rate-limiter.js';
import type { AuthManager } from '../../src/auth/auth-manager.js';

function fakeAuthManager(token = 'test-token'): AuthManager {
  return { getAccessToken: vi.fn().mockResolvedValue(token) } as unknown as AuthManager;
}

function fakeRateLimiter(): RateLimiter {
  return { acquire: vi.fn().mockResolvedValue(undefined), reportRetryAfter: vi.fn() } as unknown as RateLimiter;
}

describe('ZendeskHttpClient', () => {
  it('builds the correct URL, attaches Bearer auth, and returns parsed JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new ZendeskHttpClient({
      subdomain: 'acme',
      authManager: fakeAuthManager('token-abc'),
      rateLimiter: fakeRateLimiter(),
      fetchImpl,
    });

    const result = await client.request('/users/me.json');

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://acme.zendesk.com/api/v2/users/me.json');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-abc');
  });

  it('acquires the rate limiter before every request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const rateLimiter = fakeRateLimiter();
    const client = new ZendeskHttpClient({
      subdomain: 'acme',
      authManager: fakeAuthManager(),
      rateLimiter,
      fetchImpl,
    });
    await client.request('/tickets.json');
    expect(rateLimiter.acquire).toHaveBeenCalledTimes(1);
  });

  it('reports Retry-After to the rate limiter and throws ZendeskRateLimitError on 429', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('rate limited', { status: 429, headers: { 'Retry-After': '12' } }));
    const rateLimiter = fakeRateLimiter();
    const client = new ZendeskHttpClient({
      subdomain: 'acme',
      authManager: fakeAuthManager(),
      rateLimiter,
      fetchImpl,
    });

    await expect(client.request('/tickets.json')).rejects.toBeInstanceOf(ZendeskRateLimitError);
    expect(rateLimiter.reportRetryAfter).toHaveBeenCalledWith(12);
  });

  it('throws a mapped error on a non-429 failure status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
    const client = new ZendeskHttpClient({
      subdomain: 'acme',
      authManager: fakeAuthManager(),
      rateLimiter: fakeRateLimiter(),
      fetchImpl,
    });
    await expect(client.request('/tickets.json')).rejects.toThrow(/permission denied/i);
  });
});
