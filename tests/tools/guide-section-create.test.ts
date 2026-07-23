// tests/tools/guide-section-create.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createSection } from '../../src/tools/guide/taxonomy.js';
import { ZendeskPermissionError } from '../../src/client/errors.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_create_section-j0', path: '/x' }) } as unknown as ResponseCache;
}

describe('createSection', () => {
  it('POSTs to the category-scoped collection and defaults locale to en-us', async () => {
    const client = { request: vi.fn().mockResolvedValue({ section: { id: 30, name: 'Billing' } }) } as unknown as ZendeskHttpClient;
    const result = await createSection(client, cacheStub(), { categoryId: 9, fields: { name: 'Billing', description: 'Invoices' } });
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/help_center/categories/9/sections.json');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ section: { name: 'Billing', description: 'Invoices', locale: 'en-us' } });
    expect(result.summary).toContain('Created section #30');
  });

  it('rejects a create with no name', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(createSection(client, cacheStub(), { categoryId: 9, fields: { locale: 'de' } })).rejects.toThrow(/requires a name/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('re-maps a 403 to an actionable admin-required error', async () => {
    const client = { request: vi.fn().mockRejectedValue(new ZendeskPermissionError('Permission denied (scope ∩ role insufficient):')) } as unknown as ZendeskHttpClient;
    await expect(createSection(client, cacheStub(), { categoryId: 9, fields: { name: 'X' } })).rejects.toThrow(/requires an admin role/i);
  });
});
