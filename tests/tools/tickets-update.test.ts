// tests/tools/tickets-update.test.ts
import { describe, it, expect, vi } from 'vitest';
import { updateTicket } from '../../src/tools/tickets.js';
import { ZendeskConflictError } from '../../src/client/errors.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

// #61 added a pre-read of the current status whenever a status change is requested, so a status
// update now issues GET then PUT. `put()` picks the write out of the call list by method.
const put = (client: ZendeskHttpClient): [string, { method: string; body: string }] =>
  (client.request as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[1]?.method === 'PUT') as [string, { method: string; body: string }];

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_update_ticket-e5', path: '/x' }) } as unknown as ResponseCache;
}

describe('updateTicket', () => {
  it('sends safe_update + updated_stamp and reports success', async () => {
    // The pre-read must carry a status: #61 refuses a status change whose current status is unknown.
    const client = { request: vi.fn().mockResolvedValue({ ticket: { id: 42, status: 'open' } }) } as unknown as ZendeskHttpClient;
    const result = await updateTicket(client, cacheStub(), {
      ticketId: 42,
      fields: { status: 'pending', priority: 'low' },
      updatedStamp: '2026-07-20T10:00:00Z',
    });
    const [path, init] = put(client);
    expect(path).toBe('/tickets/42.json');
    const body = JSON.parse(init.body);
    expect(body.ticket.safe_update).toBe(true);
    expect(body.ticket.updated_stamp).toBe('2026-07-20T10:00:00Z');
    expect(body.ticket.status).toBe('pending');
    expect(result.status).toBe('updated');
  });

  it('on 409 conflict, re-fetches the current ticket and returns a conflict result (no clobber)', async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ ticket: { id: 42, status: 'open' } }) // #61 pre-read: open → solved is allowed
        .mockRejectedValueOnce(new ZendeskConflictError('Conflict'))
        .mockResolvedValueOnce({ ticket: { id: 42, subject: 'Now edited', status: 'open', updated_at: '2026-07-21T00:00:00Z' } }),
    } as unknown as ZendeskHttpClient;
    const result = await updateTicket(client, cacheStub(), {
      ticketId: 42,
      fields: { status: 'solved' },
      updatedStamp: '2026-07-20T10:00:00Z',
    });
    expect(result.status).toBe('conflict');
    if (result.status === 'conflict') {
      expect(result.currentUpdatedStamp).toBe('2026-07-21T00:00:00Z');
      expect(result.summary).toContain('changed since last read');
    }
    expect(client.request).toHaveBeenCalledTimes(3); // pre-read, PUT, conflict re-fetch
  });

  it('re-throws non-conflict errors unchanged', async () => {
    const client = { request: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as ZendeskHttpClient;
    await expect(updateTicket(client, cacheStub(), { ticketId: 1, fields: { status: 'open' }, force: true })).rejects.toThrow('boom');
  });

  it('refuses a field update with neither updatedStamp nor force (safe-by-default, no clobber)', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(updateTicket(client, cacheStub(), { ticketId: 1, fields: { status: 'open' } })).rejects.toThrow(/updatedStamp|force/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('force:true overwrites without safe_update (documented escape hatch)', async () => {
    const client = { request: vi.fn().mockResolvedValue({ ticket: { id: 7, status: 'open' } }) } as unknown as ZendeskHttpClient;
    const result = await updateTicket(client, cacheStub(), { ticketId: 7, fields: { status: 'solved' }, force: true });
    const body = JSON.parse(put(client)[1].body);
    expect(body.ticket.safe_update).toBeUndefined();
    expect(body.ticket.updated_stamp).toBeUndefined();
    expect(body.ticket.status).toBe('solved');
    expect(result.status).toBe('updated');
  });
});
