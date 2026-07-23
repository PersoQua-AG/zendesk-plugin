// tests/tools/business-rules-view-count.test.ts
import { describe, it, expect, vi } from 'vitest';
import { viewCount } from '../../src/tools/business-rules.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';

describe('viewCount', () => {
  it('returns the fresh count for a view', async () => {
    const client = { request: vi.fn().mockResolvedValue({ view_count: { view_id: 5, value: 42, fresh: true } }) } as unknown as ZendeskHttpClient;
    const result = await viewCount(client, { viewId: 5 });
    expect(client.request).toHaveBeenCalledWith('/views/5/count.json');
    expect(result.summary).toContain('42 ticket(s)');
  });

  it('appends a stale note when a real value is not fresh', async () => {
    const client = { request: vi.fn().mockResolvedValue({ view_count: { view_id: 5, value: 12, fresh: false } }) } as unknown as ZendeskHttpClient;
    const result = await viewCount(client, { viewId: 5 });
    expect(result.summary).toContain('12 ticket(s)');
    expect(result.summary).toContain('stale');
  });

  it('reports a null (not-yet-computed) value as unknown, not a true 0', async () => {
    const client = { request: vi.fn().mockResolvedValue({ view_count: { view_id: 5, value: null, fresh: false } }) } as unknown as ZendeskHttpClient;
    const result = await viewCount(client, { viewId: 5 });
    expect(result.summary).toContain('unknown');
    expect(result.summary).toContain('not a true 0');
    expect(result.summary).not.toContain('matches 0 ticket(s)');
  });

  it('throws on a malformed response envelope', async () => {
    const client = { request: vi.fn().mockResolvedValue({ nope: true }) } as unknown as ZendeskHttpClient;
    await expect(viewCount(client, { viewId: 5 })).rejects.toThrow(/Unexpected \/views\/\{id\}\/count/);
  });
});
