// tests/tools/business-rules-view-count.test.ts
import { describe, it, expect, vi } from 'vitest';
import { viewCount } from '../../src/tools/business-rules.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';

describe('viewCount', () => {
  it('returns the fresh count for a view', async () => {
    const client = { request: vi.fn().mockResolvedValue({ view_count: { view_id: 5, value: 42, fresh: true } }) } as unknown as ZendeskHttpClient;
    const result = await viewCount(client, { viewId: 5 });
    expect(client.request).toHaveBeenCalledWith('/views/5/count.json');
    expect(result.count).toBe(42);
    expect(result.summary).toContain('42 ticket(s)');
  });

  it('guards a null (not-yet-computed) value and flags a stale count', async () => {
    const client = { request: vi.fn().mockResolvedValue({ view_count: { view_id: 5, value: null, fresh: false } }) } as unknown as ZendeskHttpClient;
    const result = await viewCount(client, { viewId: 5 });
    expect(result.count).toBe(0);
    expect(result.summary).toContain('stale');
  });

  it('throws on a malformed response envelope', async () => {
    const client = { request: vi.fn().mockResolvedValue({ nope: true }) } as unknown as ZendeskHttpClient;
    await expect(viewCount(client, { viewId: 5 })).rejects.toThrow(/Unexpected \/views\/\{id\}\/count/);
  });
});
