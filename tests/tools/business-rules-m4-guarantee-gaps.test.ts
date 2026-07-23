// tests/tools/business-rules-m4-guarantee-gaps.test.ts
// QA pinning tests for M4-critical guarantees not otherwise covered:
//  1. force:true persists WITHOUT an updatedStamp and MUST NOT attach safe_update
//     (deliberate concurrency-check bypass — must not silently degrade to a safe_update PUT).
//  2. withAdminGuard must pass a NON-403 error through untouched (never mislabel it as a
//     permission problem).
import { describe, it, expect, vi } from 'vitest';
import { applyMacroToTicket, createTrigger } from '../../src/tools/business-rules.js';
import { ZendeskValidationError } from '../../src/client/errors.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'h', path: '/x' }) } as unknown as ResponseCache;
}

const previewBody = { result: { ticket: { status: 'solved', comment: { html_body: 'Resolved.' } } } };

describe('applyMacroToTicket force path', () => {
  it('persists on confirm+force without an updatedStamp and OMITS safe_update from the PUT body', async () => {
    const client = {
      request: vi.fn().mockResolvedValueOnce(previewBody).mockResolvedValueOnce({ ticket: { id: 4, status: 'solved' } }),
    } as unknown as ZendeskHttpClient;
    const result = await applyMacroToTicket(client, cacheStub(), { ticketId: 4, macroId: 9, confirm: true, force: true });
    expect(client.request).toHaveBeenCalledTimes(2);
    const [putPath, putInit] = (client.request as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(putPath).toBe('/tickets/4.json');
    expect(putInit.method).toBe('PUT');
    const body = JSON.parse(putInit.body);
    expect(body.ticket.status).toBe('solved');
    // force = deliberate overwrite: no optimistic-concurrency envelope may be attached.
    expect(body.ticket.safe_update).toBeUndefined();
    expect(body.ticket.updated_stamp).toBeUndefined();
    expect(result.status).toBe('applied');
  });

  it('still performs zero mutation when confirm is false even if force is set', async () => {
    const client = { request: vi.fn().mockResolvedValue(previewBody) } as unknown as ZendeskHttpClient;
    const result = await applyMacroToTicket(client, cacheStub(), { ticketId: 4, macroId: 9, confirm: false, force: true });
    expect(client.request).toHaveBeenCalledTimes(1); // preview GET only
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBeUndefined();
    expect(result.status).toBe('preview');
  });
});

describe('withAdminGuard non-permission passthrough', () => {
  it('does not relabel a non-403 (422 validation) error as an admin-role problem', async () => {
    const client = {
      request: vi.fn().mockRejectedValue(new ZendeskValidationError('Validation failed: title too long')),
    } as unknown as ZendeskHttpClient;
    await expect(createTrigger(client, cacheStub(), { fields: { title: 'X' } })).rejects.toThrow(/Validation failed/);
    await expect(createTrigger(client, cacheStub(), { fields: { title: 'X' } })).rejects.not.toThrow(/admin role/i);
  });
});
