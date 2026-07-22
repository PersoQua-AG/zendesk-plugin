// tests/tools/search-count.test.ts
import { describe, it, expect, vi } from 'vitest';
import { searchCount } from '../../src/tools/search.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';

describe('searchCount', () => {
  it('returns the count for a query without fetching results', async () => {
    const client = { request: vi.fn().mockResolvedValue({ count: 137 }) } as unknown as ZendeskHttpClient;
    const result = await searchCount(client, { query: 'status:open type:ticket' });
    expect(client.request).toHaveBeenCalledWith('/search/count.json?query=status%3Aopen%20type%3Aticket');
    expect(result.count).toBe(137);
    expect(result.summary).toBe('137 matching record(s).');
  });

  it('throws on a malformed count response', async () => {
    const client = { request: vi.fn().mockResolvedValue({ nope: true }) } as unknown as ZendeskHttpClient;
    await expect(searchCount(client, { query: 'x' })).rejects.toThrow(/Unexpected \/search\/count/);
  });
});
