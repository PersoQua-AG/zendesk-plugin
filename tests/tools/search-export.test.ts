// tests/tools/search-export.test.ts
import { describe, it, expect, vi } from 'vitest';
import { searchExport } from '../../src/tools/search.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_search_export-o5', path: '/x' }) } as unknown as ResponseCache;
}

describe('searchExport', () => {
  it('uses CBP with filter[type] and collects all pages up to maxRecords', async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ results: [{ id: 1, subject: 's' }], meta: { has_more: true, after_cursor: 'c1' }, links: { next: 'n' } })
        .mockResolvedValueOnce({ results: [{ id: 2, subject: 's' }], meta: { has_more: false, after_cursor: null }, links: { next: null } }),
    } as unknown as ZendeskHttpClient;
    const cache = cacheStub();
    const result = await searchExport(client, cache, { query: 'created>2026-01-01', type: 'ticket' });

    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/search/export.json?query=created%3E2026-01-01&filter[type]=ticket&page[size]=100');
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe('/search/export.json?query=created%3E2026-01-01&filter[type]=ticket&page[size]=100&page[after]=c1');
    expect(cache.save).toHaveBeenCalledWith('zendesk_search_export', { results: [{ id: 1, subject: 's' }, { id: 2, subject: 's' }] });
    expect(result.summary).toContain('2 result(s)');
  });
});
