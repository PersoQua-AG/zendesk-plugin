// tests/tools/tickets-create.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createTicket } from '../../src/tools/tickets.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_create_ticket-d4', path: '/x' }) } as unknown as ResponseCache;
}

describe('createTicket', () => {
  it('POSTs a ticket with an html_body comment (Markdown converted) and optional fields', async () => {
    const client = { request: vi.fn().mockResolvedValue({ ticket: { id: 99 } }) } as unknown as ZendeskHttpClient;
    const cache = cacheStub();
    const result = await createTicket(client, cache, {
      subject: 'Printer down',
      comment: 'Please **fix** this',
      priority: 'high',
      requesterId: 555,
      markdown: true, // resolved boolean supplied by the register layer
    });
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/tickets.json');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.ticket.subject).toBe('Printer down');
    expect(body.ticket.comment.html_body).toBe('<p>Please <strong>fix</strong> this</p>');
    expect(body.ticket.comment.public).toBe(true);
    expect(body.ticket.priority).toBe('high');
    expect(body.ticket.requester_id).toBe(555);
    expect(result.summary).toBe('Created ticket #99');
  });

  it('sends a plain-text body when markdown is disabled', async () => {
    const client = { request: vi.fn().mockResolvedValue({ ticket: { id: 1 } }) } as unknown as ZendeskHttpClient;
    await createTicket(client, cacheStub(), { subject: 's', comment: '**raw**', markdown: false });
    const body = JSON.parse((client.request as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.ticket.comment.body).toBe('**raw**');
    expect(body.ticket.comment.html_body).toBeUndefined();
  });
});
