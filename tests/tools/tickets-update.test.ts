// tests/tools/tickets-update.test.ts
import { describe, it, expect, vi } from 'vitest';
import { updateTicket } from '../../src/tools/tickets.js';
import { ZendeskConflictError } from '../../src/client/errors.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_update_ticket-e5', path: '/x' }) } as unknown as ResponseCache;
}

describe('updateTicket', () => {
  it('sends safe_update + updated_stamp and reports success', async () => {
    const client = { request: vi.fn().mockResolvedValue({ ticket: { id: 42 } }) } as unknown as ZendeskHttpClient;
    const result = await updateTicket(client, cacheStub(), {
      ticketId: 42,
      fields: { status: 'pending', priority: 'low' },
      updatedStamp: '2026-07-20T10:00:00Z',
    });
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/tickets/42.json');
    expect(init.method).toBe('PUT');
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
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it('re-throws non-conflict errors unchanged', async () => {
    const client = { request: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as ZendeskHttpClient;
    await expect(updateTicket(client, cacheStub(), { ticketId: 1, fields: { status: 'open' } })).rejects.toThrow('boom');
  });
});
