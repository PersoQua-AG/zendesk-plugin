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
        // #61: a status change pre-reads the current statuses before update_many.
        .mockResolvedValueOnce({ tickets: [{ id: 1, status: 'open' }, { id: 2, status: 'pending' }] })
        .mockResolvedValueOnce({ job_status: { id: 'job-9' } })
        .mockResolvedValueOnce({ job_status: { id: 'job-9', status: 'completed', results: [{ id: 1, success: true }] } }),
    } as unknown as ZendeskHttpClient;
    const result = await updateTicketsBulk(client, cacheStub(), { ids: [1, 2], fields: { status: 'solved' }, force: true }, { sleep: async () => {} });
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[1];
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

  // #61: a forbidden transition drops that ticket from the id list before update_many is called.
  it('drops a closed ticket from the batch and keeps the rest (lifecycle guard)', async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ tickets: [{ id: 1001, status: 'closed' }, { id: 1002, status: 'open' }] })
        .mockResolvedValueOnce({ job_status: { id: 'job-9' } })
        .mockResolvedValueOnce({ job_status: { id: 'job-9', status: 'completed', results: [{ id: 1002, success: true }] } }),
    } as unknown as ZendeskHttpClient;
    const result = await updateTicketsBulk(client, cacheStub(), { ids: [1001, 1002], fields: { status: 'pending' }, force: true }, { sleep: async () => {} });
    const calls = (client.request as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe('/tickets/show_many.json?ids=1001%2C1002');
    expect(calls[1][0]).toBe('/tickets/update_many.json?ids=1002');
    expect(result.summary).toContain('not written: 1001');
  });

  it('refuses the whole batch when no ticket may move, before any write', async () => {
    const client = {
      request: vi.fn().mockResolvedValueOnce({ tickets: [{ id: 1001, status: 'closed' }] }),
    } as unknown as ZendeskHttpClient;
    await expect(
      updateTicketsBulk(client, cacheStub(), { ids: [1001], fields: { status: 'open' }, force: true }),
    ).rejects.toThrow(/no ticket in the batch/i);
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('rejects an empty id list (collection-safety guard)', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(updateTicketsBulk(client, cacheStub(), { ids: [], fields: { status: 'open' }, force: true })).rejects.toThrow(/at least one ticket id/i);
    expect(client.request).not.toHaveBeenCalled();
  });
});
