// tests/tools/tickets-get-many.test.ts
import { describe, it, expect, vi } from 'vitest';
import { getTicketsMany } from '../../src/tools/tickets.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_get_tickets_many-c3', path: '/x' }) } as unknown as ResponseCache;
}

describe('getTicketsMany', () => {
  it('requests show_many with a comma-joined id list and screens subjects', async () => {
    const fixture = { tickets: [{ id: 1, subject: 'a', status: 'open' }, { id: 2, subject: 'b', status: 'new' }] };
    const client = { request: vi.fn().mockResolvedValue(fixture) } as unknown as ZendeskHttpClient;
    const cache = cacheStub();
    const result = await getTicketsMany(client, cache, { ids: [1, 2] });
    expect(client.request).toHaveBeenCalledWith('/tickets/show_many.json?ids=1%2C2');
    // Ingest screening caches the SCREENED tickets (subjects wrapped).
    const [toolName, cached] = (cache.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(toolName).toBe('zendesk_get_tickets_many');
    expect(cached.tickets).toHaveLength(2);
    expect(cached.tickets[0].subject).toContain('zendesk-content-ticket-1-subject-');
    expect(result.summary).toContain('#1');
    expect(result.summary).toContain('#2');
  });

  it('rejects an empty id list (collection-safety guard)', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(getTicketsMany(client, cacheStub(), { ids: [] })).rejects.toThrow(/at least one ticket id/i);
    expect(client.request).not.toHaveBeenCalled();
  });
});
