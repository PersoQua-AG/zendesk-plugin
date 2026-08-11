import { describe, it, expect, vi } from 'vitest';
import { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { TokenProvider } from '../../src/client/token-provider.js';
import type { RateLimiter } from '../../src/client/rate-limiter.js';

// Proves the client depends only on TokenProvider.getAccessToken() — not on the concrete
// AuthManager. A per-user session supplies a different TokenProvider impl over the same seam.
function fakeTokenProvider(token: string): TokenProvider {
  return { getAccessToken: vi.fn().mockResolvedValue(token) };
}

function fakeRateLimiter(): RateLimiter {
  return { acquire: vi.fn().mockResolvedValue(undefined), reportRetryAfter: vi.fn() } as unknown as RateLimiter;
}

describe('ZendeskHttpClient TokenProvider seam', () => {
  it('drives the Bearer header from any TokenProvider, not just AuthManager', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const provider = fakeTokenProvider('per-user-token');
    const client = new ZendeskHttpClient({
      subdomain: 'acme',
      authManager: provider,
      rateLimiter: fakeRateLimiter(),
      fetchImpl,
    });

    await client.request('/users/me.json');

    expect(provider.getAccessToken).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer per-user-token');
  });
});
