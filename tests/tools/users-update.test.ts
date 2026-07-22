// tests/tools/users-update.test.ts
import { describe, it, expect, vi } from 'vitest';
import { updateUser } from '../../src/tools/users.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_update_user-d4', path: '/x' }) } as unknown as ResponseCache;
}

describe('updateUser', () => {
  it('PUTs /users/{id} with the changed fields and screens the echoed record', async () => {
    const client = { request: vi.fn().mockResolvedValue({ user: { id: 9, name: 'Carol', email: 'c@x.io', role: 'agent' } }) } as unknown as ZendeskHttpClient;
    const cache = cacheStub();
    const result = await updateUser(client, cache, { userId: 9, fields: { role: 'agent' } });
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/users/9.json');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ user: { role: 'agent' } });
    const [toolName] = (cache.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(toolName).toBe('zendesk_update_user');
    expect(result.summary).toContain('Updated user #9');
  });

  it('rejects an empty field set (nothing to change)', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(updateUser(client, cacheStub(), { userId: 9, fields: {} })).rejects.toThrow(/at least one field/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('throws on a malformed response envelope', async () => {
    const client = { request: vi.fn().mockResolvedValue({ nope: true }) } as unknown as ZendeskHttpClient;
    await expect(updateUser(client, cacheStub(), { userId: 9, fields: { role: 'agent' } })).rejects.toThrow(/Unexpected \/users\/\{id\} update/);
  });
});
