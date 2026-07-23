// tests/tools/guide-reuse-enablement.test.ts
// createEntity + withAdminGuard live in the neutral write-helpers module (not a domain package),
// so both business-rules and Guide reuse them without a cross-domain import edge. These pins keep
// the generic create tail + admin guard usable for a guide-style entity from the neutral home.
import { describe, it, expect, vi } from 'vitest';
import { createEntity, updateEntity, withAdminGuard } from '../../src/tools/write-helpers.js';
import { ZendeskPermissionError } from '../../src/client/errors.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'reuse-a1', path: '/x' }) } as unknown as ResponseCache;
}

describe('reuse enablement', () => {
  it('createEntity is exported from write-helpers and usable for a guide-style (category) entity', async () => {
    const client = { request: vi.fn().mockResolvedValue({ category: { id: 12, name: 'FAQ' } }) } as unknown as ZendeskHttpClient;
    const r = await createEntity(
      client,
      cacheStub(),
      { collection: '/help_center/categories', key: 'category', toolName: 'zendesk_create_category', resourceLabel: 'category', requiredFields: ['name', 'locale'] },
      { name: 'FAQ', locale: 'en-us' },
      'standard',
    );
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/help_center/categories.json');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ category: { name: 'FAQ', locale: 'en-us' } });
    expect(r.summary).toContain('Created category #12');
  });

  it('createEntity enforces a parameterized required field', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(
      createEntity(client, cacheStub(), { collection: '/help_center/categories', key: 'category', toolName: 'zendesk_create_category', resourceLabel: 'category', requiredFields: ['name', 'locale'] }, { name: 'FAQ' }, 'standard'),
    ).rejects.toThrow(/requires a locale/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('withAdminGuard is exported from write-helpers and re-maps a scope∩role 403', async () => {
    await expect(
      withAdminGuard('Creating a category', () => {
        throw new ZendeskPermissionError('Permission denied (scope ∩ role insufficient):');
      }),
    ).rejects.toThrow(/requires an admin role/i);
  });

  it('updateEntity accepts a string id (locale-keyed translation path)', async () => {
    const client = { request: vi.fn().mockResolvedValue({ translation: { id: 99, title: 'Hallo' } }) } as unknown as ZendeskHttpClient;
    await updateEntity(
      client,
      cacheStub(),
      { collection: '/help_center/articles/5/translations', key: 'translation', toolName: 'zendesk_update_article_translation', resourceLabel: 'article translation' },
      'de',
      { title: 'Hallo' },
      'standard',
    );
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/help_center/articles/5/translations/de.json');
    expect(init.method).toBe('PUT');
  });
});
