// tests/tools/business-rules-macro-apply.test.ts
import { describe, it, expect, vi } from 'vitest';
import { applyMacroToTicket } from '../../src/tools/business-rules.js';
import { ZendeskConflictError } from '../../src/client/errors.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_apply_macro_to_ticket-f6', path: '/x' }) } as unknown as ResponseCache;
}

const previewBody = { result: { ticket: { status: 'solved', comment: { html_body: 'Resolved.' } } } };

describe('applyMacroToTicket', () => {
  it('previews only (read-only, no PUT) when confirm is omitted', async () => {
    const client = { request: vi.fn().mockResolvedValue(previewBody) } as unknown as ZendeskHttpClient;
    const cache = cacheStub();
    const result = await applyMacroToTicket(client, cache, { ticketId: 4, macroId: 9 });
    expect(client.request).toHaveBeenCalledTimes(1);
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/tickets/4/macros/9/apply.json');
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBeUndefined();
    expect(result.status).toBe('preview');
    expect(result.summary).toContain('PREVIEW ONLY');
    expect(result.summary).toContain('confirm:true');
  });

  it('refuses to persist on confirm without updatedStamp or force', async () => {
    const client = { request: vi.fn().mockResolvedValue(previewBody) } as unknown as ZendeskHttpClient;
    await expect(applyMacroToTicket(client, cacheStub(), { ticketId: 4, macroId: 9, confirm: true })).rejects.toThrow(/without an updatedStamp/i);
  });

  it('persists via PUT with safe_update when confirm + updatedStamp are supplied', async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce(previewBody) // ticket-scoped preview
        .mockResolvedValueOnce({ ticket: { id: 4, status: 'solved' } }), // PUT echo
    } as unknown as ZendeskHttpClient;
    const cache = cacheStub();
    const result = await applyMacroToTicket(client, cache, { ticketId: 4, macroId: 9, confirm: true, updatedStamp: '2026-07-23T10:00:00Z' });
    expect(client.request).toHaveBeenCalledTimes(2);
    const [putPath, putInit] = (client.request as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(putPath).toBe('/tickets/4.json');
    expect(putInit.method).toBe('PUT');
    const body = JSON.parse(putInit.body);
    expect(body.ticket.status).toBe('solved');
    expect(body.ticket.safe_update).toBe(true);
    expect(body.ticket.updated_stamp).toBe('2026-07-23T10:00:00Z');
    expect(result.status).toBe('applied');
    expect(result.summary).toContain('Applied macro #9 to ticket #4');
  });

  it('returns a conflict (re-fetch) when the PUT 409s', async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce(previewBody)
        .mockRejectedValueOnce(new ZendeskConflictError('conflict'))
        .mockResolvedValueOnce({ ticket: { id: 4, status: 'open', updated_at: '2026-07-23T11:00:00Z' } }),
    } as unknown as ZendeskHttpClient;
    const cache = cacheStub();
    const result = await applyMacroToTicket(client, cache, { ticketId: 4, macroId: 9, confirm: true, updatedStamp: 'stale' });
    expect(result.status).toBe('conflict');
    if (result.status === 'conflict') {
      expect(result.currentUpdatedStamp).toBe('2026-07-23T11:00:00Z');
      expect(result.summary).toContain('changed since');
    }
  });

  it('throws on a malformed preview envelope', async () => {
    const client = { request: vi.fn().mockResolvedValue({ nope: true }) } as unknown as ZendeskHttpClient;
    await expect(applyMacroToTicket(client, cacheStub(), { ticketId: 4, macroId: 9 })).rejects.toThrow(/Unexpected \/tickets\/\{id\}\/macros/);
  });
});
