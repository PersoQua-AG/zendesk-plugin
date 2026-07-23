// tests/tools/guide-empty-body.test.ts
// QA #4: a whitespace-only body renders to non-empty-but-content-empty HTML (markdownToHtml('# ')
// -> '<h1></h1>'), which would slip past createEntity's required-`body` guard. A body that renders
// to effectively-empty (no text content) — or is raw-HTML-empty when markdown:false — must be
// treated as MISSING so the required-field guard rejects the create and no request is issued.
import { describe, it, expect, vi } from 'vitest';
import { createArticle, createArticleTranslation } from '../../src/tools/guide/articles.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'h', path: '/x' }) } as unknown as ResponseCache;
}

describe('createArticle effectively-empty body', () => {
  it.each(['# ', '   ', '\n\t'])('rejects a whitespace/heading-only markdown body %j', async (body) => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(createArticle(client, cacheStub(), { sectionId: 3, fields: { title: 'T', body }, markdown: true })).rejects.toThrow(/requires a body/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('rejects a content-empty raw HTML body when markdown:false', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(createArticle(client, cacheStub(), { sectionId: 3, fields: { title: 'T', body: '<h1></h1>' }, markdown: false })).rejects.toThrow(/requires a body/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('still accepts a body with real content', async () => {
    const client = { request: vi.fn().mockResolvedValue({ article: { id: 7 } }) } as unknown as ZendeskHttpClient;
    await createArticle(client, cacheStub(), { sectionId: 3, fields: { title: 'T', body: '# Hello' }, markdown: true });
    expect(JSON.parse((client.request as ReturnType<typeof vi.fn>).mock.calls[0][1].body).article.body).toBe('<h1>Hello</h1>');
  });
});

describe('createArticleTranslation effectively-empty body', () => {
  it('rejects a whitespace-only markdown body', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(
      createArticleTranslation(client, cacheStub(), { articleId: 5, fields: { locale: 'de', title: 'T', body: '# ' }, markdown: true }),
    ).rejects.toThrow(/requires a body/i);
    expect(client.request).not.toHaveBeenCalled();
  });
});
