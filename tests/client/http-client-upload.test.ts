// tests/client/http-client-upload.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ZendeskHttpClient } from '../../src/client/http-client.js';
import { ZendeskPermissionError } from '../../src/client/errors.js';
import type { RateLimiter } from '../../src/client/rate-limiter.js';
import type { AuthManager } from '../../src/auth/auth-manager.js';

function fakeAuth(): AuthManager {
  return { getAccessToken: vi.fn().mockResolvedValue('tok') } as unknown as AuthManager;
}
function fakeLimiter(): RateLimiter {
  return { acquire: vi.fn().mockResolvedValue(undefined), reportRetryAfter: vi.fn() } as unknown as RateLimiter;
}

describe('ZendeskHttpClient.requestUpload', () => {
  it('sends a binary body with the given content-type + Bearer auth and returns parsed JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ upload: { token: 'up-1' } }), { status: 201 }));
    const limiter = fakeLimiter();
    const client = new ZendeskHttpClient({ subdomain: 'acme', authManager: fakeAuth(), rateLimiter: limiter, fetchImpl });

    const bytes = new Uint8Array([1, 2, 3]);
    const result = await client.requestUpload<{ upload: { token: string } }>('/uploads.json?filename=a.png', bytes, 'application/binary');

    expect(result.upload.token).toBe('up-1');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://acme.zendesk.com/api/v2/uploads.json?filename=a.png');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(bytes);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/binary');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(limiter.acquire).toHaveBeenCalledTimes(1);
  });

  it('maps a non-2xx response to a typed error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
    const client = new ZendeskHttpClient({ subdomain: 'acme', authManager: fakeAuth(), rateLimiter: fakeLimiter(), fetchImpl });
    await expect(client.requestUpload('/uploads.json', new Uint8Array([0]), 'application/binary')).rejects.toBeInstanceOf(ZendeskPermissionError);
  });
});
