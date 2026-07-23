// tests/tools/ticket-tags.test.ts
import { describe, it, expect, vi } from 'vitest';
import { addTicketTags } from '../../src/tools/ticket-tags.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_add_ticket_tags-h8', path: '/x' }) } as unknown as ResponseCache;
}

describe('addTicketTags', () => {
  it('appends tags via POST by default (no blind PUT-replace)', async () => {
    const client = { request: vi.fn().mockResolvedValue({ tags: ['vip', 'billing'] }) } as unknown as ZendeskHttpClient;
    const result = await addTicketTags(client, cacheStub(), { ticketId: 3, tags: ['billing'] });
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/tickets/3/tags.json');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ tags: ['billing'] });
    expect(result.summary).toContain('Appended');
  });

  it('replaces all tags via PUT only when replace:true is set', async () => {
    const client = { request: vi.fn().mockResolvedValue({ tags: ['only'] }) } as unknown as ZendeskHttpClient;
    const result = await addTicketTags(client, cacheStub(), { ticketId: 3, tags: ['only'], replace: true });
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe('PUT');
    expect(result.summary).toContain('Replaced');
  });

  it('rejects an empty tag list (collection-safety guard)', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(addTicketTags(client, cacheStub(), { ticketId: 3, tags: [] })).rejects.toThrow(/at least one tag/i);
    expect(client.request).not.toHaveBeenCalled();
  });
});
