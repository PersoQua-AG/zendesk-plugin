// tests/tools/analytics-incremental-users.test.ts
import { describe, it, expect, vi } from 'vitest';
import { incrementalUsers } from '../../src/tools/analytics/incremental.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_incremental_users-a1', path: '/x' }) } as unknown as ResponseCache;
}

describe('incrementalUsers', () => {
  it('pages cursor-mode via the incremental rate class and fences name', async () => {
    const client = {
      request: vi.fn().mockResolvedValue({
        users: [{ id: 1, name: 'Alice', email: 'a@x.io', role: 'end-user', created_at: '2026-07-01T00:00:00Z' }],
        after_cursor: 'c1', end_of_stream: true,
      }),
    } as unknown as ZendeskHttpClient;
    const cache = cacheStub();
    const r = await incrementalUsers(client, cache, { startTime: 1719_000_000 });
    const calls = (client.request as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain('/incremental/users/cursor.json?start_time=1719000000');
    expect(calls[0][2]).toEqual({ rateClass: 'incremental' });
    const [, cached] = (cache.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cached.users[0].name).toContain('zendesk-content-inc-user-1-name-');
    expect(r.summary).toContain('1 user(s)');
  });

  it('rejects a non-positive start_time', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(incrementalUsers(client, cacheStub(), { startTime: -5 })).rejects.toThrow(/start_time/i);
  });
});
