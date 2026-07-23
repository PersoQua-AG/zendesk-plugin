// tests/tools/guide-translation-locale-shape.test.ts
// QA #2: the translation tools must validate the locale shape themselves, not rely solely on the
// register regex — a direct in-process caller passing a path-segment locale ("../../users/1")
// must be rejected before it can reach the URL path, and no request may be issued.
import { describe, it, expect, vi } from 'vitest';
import { createArticleTranslation, updateArticleTranslation } from '../../src/tools/guide/articles.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'h', path: '/x' }) } as unknown as ResponseCache;
}

describe('translation locale shape validation', () => {
  it('updateArticleTranslation rejects a traversal locale and issues no request', () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    expect(() => updateArticleTranslation(client, cacheStub(), { articleId: 5, locale: '../../users/1', fields: { title: 'x' }, markdown: true })).toThrow(/locale/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('updateArticleTranslation rejects a slash-bearing locale', () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    expect(() => updateArticleTranslation(client, cacheStub(), { articleId: 5, locale: 'foo/bar', fields: { title: 'x' }, markdown: true })).toThrow(/locale/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('createArticleTranslation rejects a traversal locale and issues no request', () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    expect(() => createArticleTranslation(client, cacheStub(), { articleId: 5, fields: { locale: '../x', title: 'x', body: 'y' }, markdown: true })).toThrow(/locale/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('accepts a well-formed locale (de)', async () => {
    const client = { request: vi.fn().mockResolvedValue({ translation: { id: 1, locale: 'de' } }) } as unknown as ZendeskHttpClient;
    await updateArticleTranslation(client, cacheStub(), { articleId: 5, locale: 'de', fields: { title: 'x' }, markdown: true });
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/help_center/articles/5/translations/de.json');
  });
});
