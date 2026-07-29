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
    expect(result.cacheHandle).toBe('zendesk_get_me-abc123');
    // name/email are rendered from the FENCED safe copy, never raw (parity with getUser).
    expect(result.summary).toContain('zendesk-content-me-name-');
    expect(result.summary).toContain('zendesk-content-me-email-');
    expect(result.summary).toContain('Ada Lovelace');
    expect(result.summary).toContain('ada@acme.com');
    // id (numeric) and role (enum) stay raw.
    expect(result.summary).toContain('role: admin');
  });

  it('caches the screened copy so a zendesk_query replay is also fenced', async () => {
    const fixture = { user: { id: 1, name: 'Ada Lovelace', email: 'ada@acme.com', role: 'admin' } };
    const client = { request: vi.fn().mockResolvedValue(fixture) } as unknown as ZendeskHttpClient;
    const cache = { save: vi.fn().mockReturnValue({ handle: 'zendesk_get_me-abc123', path: '/tmp/x' }) } as unknown as ResponseCache;

    await getMe(client, cache);

    const [toolName, cached] = (cache.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(toolName).toBe('zendesk_get_me');
    expect(cached.user.name).toContain('zendesk-content-me-name-');
    expect(cached.user.email).toContain('zendesk-content-me-email-');
  });

  it('throws a clear error when the response is missing a valid user object', async () => {
    const client = { request: vi.fn().mockResolvedValue({ error: 'Unauthorized' }) } as unknown as ZendeskHttpClient;
    const cache = { save: vi.fn() } as unknown as ResponseCache;
    await expect(getMe(client, cache)).rejects.toThrow(/user/i);
    expect(cache.save).not.toHaveBeenCalled();
  });
});
