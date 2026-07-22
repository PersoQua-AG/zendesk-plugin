import { describe, it, expect, vi } from 'vitest';
import { getMe } from '../../src/tools/me.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

describe('getMe', () => {
  it('summarizes the authenticated user and returns a cache handle', async () => {
    const fixture = { user: { id: 1, name: 'Ada Lovelace', email: 'ada@acme.com', role: 'admin' } };
    const client = { request: vi.fn().mockResolvedValue(fixture) } as unknown as ZendeskHttpClient;
    const cache = { save: vi.fn().mockReturnValue({ handle: 'zendesk_get_me-abc123', path: '/tmp/x' }) } as unknown as ResponseCache;

    const result = await getMe(client, cache);

    expect(client.request).toHaveBeenCalledWith('/users/me.json');
    expect(cache.save).toHaveBeenCalledWith('zendesk_get_me', fixture);
    expect(result.summary).toBe('Authenticated as Ada Lovelace <ada@acme.com> — role: admin');
    expect(result.cacheHandle).toBe('zendesk_get_me-abc123');
  });

  it('throws a clear error when the response is missing a valid user object', async () => {
    const client = { request: vi.fn().mockResolvedValue({ error: 'Unauthorized' }) } as unknown as ZendeskHttpClient;
    const cache = { save: vi.fn() } as unknown as ResponseCache;
    await expect(getMe(client, cache)).rejects.toThrow(/user/i);
    expect(cache.save).not.toHaveBeenCalled();
  });
});
