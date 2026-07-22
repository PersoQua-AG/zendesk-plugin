// tests/tools/orgs-update.test.ts
import { describe, it, expect, vi } from 'vitest';
import { updateOrg } from '../../src/tools/orgs.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_update_org-i9', path: '/x' }) } as unknown as ResponseCache;
}

describe('updateOrg', () => {
  it('PUTs /organizations/{id} with the changed fields', async () => {
    const client = { request: vi.fn().mockResolvedValue({ organization: { id: 5, name: 'Acme', notes: 'updated' } }) } as unknown as ZendeskHttpClient;
    const cache = cacheStub();
    const result = await updateOrg(client, cache, { orgId: 5, fields: { notes: 'updated' } });
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/organizations/5.json');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ organization: { notes: 'updated' } });
    const [toolName] = (cache.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(toolName).toBe('zendesk_update_org');
    expect(result.summary).toContain('Updated organization #5');
  });

  it('rejects an empty field set (nothing to change)', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(updateOrg(client, cacheStub(), { orgId: 5, fields: {} })).rejects.toThrow(/at least one field/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('throws on a malformed response envelope', async () => {
    const client = { request: vi.fn().mockResolvedValue({ nope: true }) } as unknown as ZendeskHttpClient;
    await expect(updateOrg(client, cacheStub(), { orgId: 5, fields: { notes: 'x' } })).rejects.toThrow(/Unexpected \/organizations\/\{id\} update/);
  });
});
