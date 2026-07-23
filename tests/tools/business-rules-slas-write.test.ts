// tests/tools/business-rules-slas-write.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createSla, updateSla } from '../../src/tools/business-rules.js';
import { ZendeskPermissionError } from '../../src/client/errors.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_create_sla-l2', path: '/x' }) } as unknown as ResponseCache;
}

describe('createSla', () => {
  it('POSTs /slas/policies with the sla_policy body and reports the new id', async () => {
    const client = { request: vi.fn().mockResolvedValue({ sla_policy: { id: 90, title: 'Gold SLA' } }) } as unknown as ZendeskHttpClient;
    const result = await createSla(client, cacheStub(), {
      fields: { title: 'Gold SLA', policy_metrics: [{ priority: 'high', metric: 'first_reply_time', target: 30, business_hours: false }] },
    });
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/slas/policies.json');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).sla_policy.title).toBe('Gold SLA');
    expect(result.summary).toContain('Created sla-policy #90');
  });

  it('re-maps a 403 to an actionable admin-required error', async () => {
    const client = { request: vi.fn().mockRejectedValue(new ZendeskPermissionError('Permission denied')) } as unknown as ZendeskHttpClient;
    await expect(createSla(client, cacheStub(), { fields: { title: 'X' } })).rejects.toThrow(/requires an admin role/i);
  });
});

describe('updateSla', () => {
  it('PUTs /slas/policies/{id} with the changed fields', async () => {
    const client = { request: vi.fn().mockResolvedValue({ sla_policy: { id: 90, title: 'Gold SLA' } }) } as unknown as ZendeskHttpClient;
    const result = await updateSla(client, cacheStub(), { id: 90, fields: { title: 'Gold SLA v2' } });
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/slas/policies/90.json');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ sla_policy: { title: 'Gold SLA v2' } });
    expect(result.summary).toContain('Updated sla-policy #90');
  });

  it('rejects an empty (no-op) field set', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(updateSla(client, cacheStub(), { id: 90, fields: {} })).rejects.toThrow(/at least one field/i);
    expect(client.request).not.toHaveBeenCalled();
  });
});
