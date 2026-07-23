// tests/tools/guide-translation-create.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createArticleTranslation } from '../../src/tools/guide/articles.js';
import { ZendeskPermissionError } from '../../src/client/errors.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_create_article_translation-f6', path: '/x' }) } as unknown as ResponseCache;
}

describe('createArticleTranslation', () => {
  it('POSTs a locale-scoped translation with a Markdown→HTML body', async () => {
    const client = { request: vi.fn().mockResolvedValue({ translation: { id: 80, locale: 'de' } }) } as unknown as ZendeskHttpClient;
    const result = await createArticleTranslation(client, cacheStub(), { articleId: 5, fields: { locale: 'de', title: 'Hallo', body: '# Hallo' }, markdown: true });
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/help_center/articles/5/translations.json');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.translation.locale).toBe('de');
    expect(body.translation.title).toBe('Hallo');
    expect(body.translation.body).toBe('<h1>Hallo</h1>');
    expect(result.summary).toContain('Created article translation #80');
  });

  it('defaults the locale to en-us when omitted', async () => {
    const client = { request: vi.fn().mockResolvedValue({ translation: { id: 81 } }) } as unknown as ZendeskHttpClient;
    await createArticleTranslation(client, cacheStub(), { articleId: 5, fields: { title: 'Hi', body: 'x' }, markdown: true });
    expect(JSON.parse((client.request as ReturnType<typeof vi.fn>).mock.calls[0][1].body).translation.locale).toBe('en-us');
  });

  it('rejects a create with no title', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(createArticleTranslation(client, cacheStub(), { articleId: 5, fields: { locale: 'de', body: 'x' }, markdown: true })).rejects.toThrow(/requires a title/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('re-maps a 403 to an actionable admin-required error', async () => {
    const client = { request: vi.fn().mockRejectedValue(new ZendeskPermissionError('Permission denied (scope ∩ role insufficient):')) } as unknown as ZendeskHttpClient;
    await expect(createArticleTranslation(client, cacheStub(), { articleId: 5, fields: { locale: 'de', title: 'Hallo', body: 'x' }, markdown: true })).rejects.toThrow(/requires an admin role/i);
  });
});
