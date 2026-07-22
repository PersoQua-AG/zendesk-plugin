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
    // Ingest screening caches the SCREENED results (subjects wrapped).
    const [toolName, cached] = (cache.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(toolName).toBe('zendesk_search_export');
    expect(cached.results).toHaveLength(2);
    expect(cached.results[0].subject).toContain('zendesk-content-search-subject-');
    expect(result.summary).toContain('2 result(s)');
  });
});
