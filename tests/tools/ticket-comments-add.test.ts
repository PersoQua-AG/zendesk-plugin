// tests/tools/ticket-comments-add.test.ts
import { describe, it, expect, vi } from 'vitest';
import { addComment } from '../../src/tools/ticket-comments.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_add_comment-f6', path: '/x' }) } as unknown as ResponseCache;
}

describe('addComment', () => {
  it('PUTs an html_body comment (Markdown converted) defaulting to public', async () => {
    const client = { request: vi.fn().mockResolvedValue({ ticket: { id: 5 } }) } as unknown as ZendeskHttpClient;
    // markdown is a resolved boolean supplied by the register layer (no hidden tool default).
    const result = await addComment(client, cacheStub(), { ticketId: 5, body: 'Fixed in *v2*', markdown: true });
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/tickets/5.json');
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body);
    expect(body.ticket.comment.html_body).toBe('<p>Fixed in <em>v2</em></p>');
    expect(body.ticket.comment.public).toBe(true);
    expect(result.summary).toBe('Added public comment to ticket #5');
  });

  it('supports an internal (private) plain-text note', async () => {
    const client = { request: vi.fn().mockResolvedValue({ ticket: { id: 5 } }) } as unknown as ZendeskHttpClient;
    const result = await addComment(client, cacheStub(), { ticketId: 5, body: 'internal', public: false, markdown: false });
    const body = JSON.parse((client.request as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.ticket.comment.body).toBe('internal');
    expect(body.ticket.comment.public).toBe(false);
    expect(result.summary).toBe('Added internal comment to ticket #5');
  });
});
