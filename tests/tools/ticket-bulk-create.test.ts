// tests/tools/ticket-bulk-create.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createTicketsBulk } from '../../src/tools/ticket-bulk.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_create_tickets_bulk-i9', path: '/x' }) } as unknown as ResponseCache;
}

describe('createTicketsBulk', () => {
  it('POSTs create_many, polls the job to completion, and reports per-record failures', async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ job_status: { id: 'job-1' } })
        .mockResolvedValueOnce({ job_status: { id: 'job-1', status: 'completed', results: [{ id: 1, success: true }, { id: 2, success: false, errors: ['RecordInvalid'] }] } }),
    } as unknown as ZendeskHttpClient;
    const cache = cacheStub();
    const result = await createTicketsBulk(client, cache, { tickets: [{ subject: 'a' }, { subject: 'b' }] }, { sleep: async () => {} });

    const [createPath, createInit] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(createPath).toBe('/tickets/create_many.json');
    expect(createInit.method).toBe('POST');
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe('/job_statuses/job-1.json');
    expect(result.jobStatus).toBe('completed');
    expect(result.failures).toEqual([{ id: 2, success: false, errors: ['RecordInvalid'] }]);
    expect(result.summary).toContain('1 failed');
  });

  it('rejects an empty ticket batch (collection-safety guard)', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(createTicketsBulk(client, cacheStub(), { tickets: [] })).rejects.toThrow(/at least one ticket/i);
    expect(client.request).not.toHaveBeenCalled();
  });
});
