// tests/tools/org-memberships.test.ts
import { describe, it, expect, vi } from 'vitest';
import { listOrgMemberships } from '../../src/tools/orgs.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_list_org_memberships-j0', path: '/x' }) } as unknown as ResponseCache;
}

describe('listOrgMemberships', () => {
  it('paginates via CBP and caches the memberships (id-only records, nothing to flag)', async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          organization_memberships: [{ id: 1, user_id: 10, organization_id: 100, default: true }],
          meta: { has_more: true, after_cursor: 'c1' },
          links: { next: 'n' },
        })
        .mockResolvedValueOnce({
          organization_memberships: [{ id: 2, user_id: 11, organization_id: 100 }],
          meta: { has_more: false, after_cursor: null },
          links: { next: null },
        }),
    } as unknown as ZendeskHttpClient;
    const cache = cacheStub();
    const result = await listOrgMemberships(client, cache, {});

    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('/organization_memberships.json');
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('page[size]=100');
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain('page[after]=c1');
    const [toolName, cached] = (cache.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(toolName).toBe('zendesk_list_org_memberships');
    expect(cached.organization_memberships).toHaveLength(2);
    expect(result.flagged).toBe(false);
    expect(result.summary).toContain('2 organization membership(s)');
  });

  it('throws on a malformed response envelope', async () => {
    const client = { request: vi.fn().mockResolvedValue({ nope: true }) } as unknown as ZendeskHttpClient;
    await expect(listOrgMemberships(client, cacheStub(), {})).rejects.toThrow(/Unexpected \/organization_memberships/);
  });
});
