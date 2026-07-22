// tests/tools/ticket-bulk-update.test.ts
import { describe, it, expect, vi } from 'vitest';
import { updateTicketsBulk } from '../../src/tools/ticket-bulk.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_update_tickets_bulk-j0', path: '/x' }) } as unknown as ResponseCache;
}

describe('updateTicketsBulk', () => {
  it('PUTs update_many with ids + shared fields and polls the job when force:true', async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ job_status: { id: 'job-9' } })
        .mockResolvedValueOnce({ job_status: { id: 'job-9', status: 'completed', results: [{ id: 1, success: true }] } }),
    } as unknown as ZendeskHttpClient;
    const result = await updateTicketsBulk(client, cacheStub(), { ids: [1, 2], fields: { status: 'solved' }, force: true }, { sleep: async () => {} });
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/tickets/update_many.json?ids=1%2C2');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ ticket: { status: 'solved' } });
    expect(result.jobStatus).toBe('completed');
  });

  it('refuses a bulk field update without force:true (safe_update bypass guard)', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(updateTicketsBulk(client, cacheStub(), { ids: [1, 2], fields: { status: 'solved' } })).rejects.toThrow(/force:true/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('rejects an empty id list (collection-safety guard)', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(updateTicketsBulk(client, cacheStub(), { ids: [], fields: { status: 'open' }, force: true })).rejects.toThrow(/at least one ticket id/i);
    expect(client.request).not.toHaveBeenCalled();
  });
});
