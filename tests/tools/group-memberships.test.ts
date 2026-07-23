// tests/tools/group-memberships.test.ts
import { describe, it, expect, vi } from 'vitest';
import { listGroupMemberships } from '../../src/tools/groups.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_list_group_memberships-l2', path: '/x' }) } as unknown as ResponseCache;
}

describe('listGroupMemberships', () => {
  it('paginates via CBP and caches the memberships (id-only records, nothing to flag)', async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          group_memberships: [{ id: 1, user_id: 10, group_id: 100, default: true }],
          meta: { has_more: true, after_cursor: 'c1' },
          links: { next: 'n' },
        })
        .mockResolvedValueOnce({
          group_memberships: [{ id: 2, user_id: 11, group_id: 100 }],
          meta: { has_more: false, after_cursor: null },
          links: { next: null },
        }),
    } as unknown as ZendeskHttpClient;
    const cache = cacheStub();
    const result = await listGroupMemberships(client, cache, {});

    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('/group_memberships.json');
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('page[size]=100');
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain('page[after]=c1');
    const [toolName, cached] = (cache.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(toolName).toBe('zendesk_list_group_memberships');
    expect(cached.group_memberships).toHaveLength(2);
    expect(result.flagged).toBe(false);
    expect(result.summary).toContain('2 group membership(s)');
  });

  it('throws on a malformed response envelope', async () => {
    const client = { request: vi.fn().mockResolvedValue({ nope: true }) } as unknown as ZendeskHttpClient;
    await expect(listGroupMemberships(client, cacheStub(), {})).rejects.toThrow(/Unexpected \/group_memberships/);
  });
});
