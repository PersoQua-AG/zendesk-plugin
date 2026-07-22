// tests/tools/business-rules-automations-write.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createAutomation, updateAutomation } from '../../src/tools/business-rules.js';
import { ZendeskPermissionError } from '../../src/client/errors.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_create_automation-k1', path: '/x' }) } as unknown as ResponseCache;
}

describe('createAutomation', () => {
  it('POSTs /automations with the rule body and reports the new id', async () => {
    const client = { request: vi.fn().mockResolvedValue({ automation: { id: 70, title: 'Auto-close' } }) } as unknown as ZendeskHttpClient;
    const result = await createAutomation(client, cacheStub(), { fields: { title: 'Auto-close' } });
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/automations.json');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ automation: { title: 'Auto-close' } });
    expect(result.summary).toContain('Created automation #70');
  });

  it('re-maps a 403 to an actionable admin-required error', async () => {
    const client = { request: vi.fn().mockRejectedValue(new ZendeskPermissionError('Permission denied')) } as unknown as ZendeskHttpClient;
    await expect(createAutomation(client, cacheStub(), { fields: { title: 'X' } })).rejects.toThrow(/requires an admin role/i);
  });
});

describe('updateAutomation', () => {
  it('PUTs /automations/{id} with the changed fields', async () => {
    const client = { request: vi.fn().mockResolvedValue({ automation: { id: 70, title: 'Auto-close', active: false } }) } as unknown as ZendeskHttpClient;
    const result = await updateAutomation(client, cacheStub(), { id: 70, fields: { active: false } });
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/automations/70.json');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ automation: { active: false } });
    expect(result.summary).toContain('Updated automation #70');
  });

  it('rejects an empty (no-op) field set', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(updateAutomation(client, cacheStub(), { id: 70, fields: {} })).rejects.toThrow(/at least one field/i);
    expect(client.request).not.toHaveBeenCalled();
  });
});
