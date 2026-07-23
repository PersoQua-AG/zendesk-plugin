// tests/tools/ticket-metadata.test.ts
import { describe, it, expect, vi } from 'vitest';
import { listTicketFields, listTicketForms } from '../../src/tools/ticket-metadata.js';
import { ZendeskPermissionError } from '../../src/client/errors.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(handle: string): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle, path: '/x' }) } as unknown as ResponseCache;
}

describe('listTicketFields', () => {
  it('fetches and caches ticket fields', async () => {
    const client = { request: vi.fn().mockResolvedValue({ ticket_fields: [{ id: 1, title: 'Subject', type: 'subject' }] }) } as unknown as ZendeskHttpClient;
    const result = await listTicketFields(client, cacheStub('zendesk_list_ticket_fields-l2'));
    expect(client.request).toHaveBeenCalledWith('/ticket_fields.json');
    expect(result.summary).toContain('1 ticket field(s)');
  });
});

describe('listTicketForms', () => {
  it('fetches forms when available', async () => {
    const client = { request: vi.fn().mockResolvedValue({ ticket_forms: [{ id: 1, name: 'Default' }] }) } as unknown as ZendeskHttpClient;
    const result = await listTicketForms(client, cacheStub('zendesk_list_ticket_forms-m3'));
    expect(result.available).toBe(true);
    expect(result.cacheHandle).toBe('zendesk_list_ticket_forms-m3');
  });

  it('degrades gracefully to available:false on a permission error (Enterprise-gated)', async () => {
    const client = { request: vi.fn().mockRejectedValue(new ZendeskPermissionError('nope')) } as unknown as ZendeskHttpClient;
    const result = await listTicketForms(client, cacheStub('unused'));
    expect(result.available).toBe(false);
    expect(result.cacheHandle).toBeNull();
    expect(result.summary).toMatch(/Enterprise/i);
  });
});
