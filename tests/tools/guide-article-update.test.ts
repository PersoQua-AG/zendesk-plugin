// tests/tools/guide-article-update.test.ts
import { describe, it, expect, vi } from 'vitest';
import { updateArticle } from '../../src/tools/guide/articles.js';
import { ZendeskPermissionError } from '../../src/client/errors.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_update_article-e5', path: '/x' }) } as unknown as ResponseCache;
}

describe('updateArticle', () => {
  it('PUTs the article with a Markdown→HTML body', async () => {
    const client = { request: vi.fn().mockResolvedValue({ article: { id: 50, title: 'Guide' } }) } as unknown as ZendeskHttpClient;
    const result = await updateArticle(client, cacheStub(), { articleId: 50, fields: { body: '# New' }, markdown: true });
    const [path, init] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/help_center/articles/50.json');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ article: { body: '<h1>New</h1>' } });
    expect(result.summary).toContain('Updated article #50');
  });

  it('passes a raw HTML body through when markdown:false and updates draft', async () => {
    const client = { request: vi.fn().mockResolvedValue({ article: { id: 50 } }) } as unknown as ZendeskHttpClient;
    await updateArticle(client, cacheStub(), { articleId: 50, fields: { body: '<p>Raw</p>', draft: true }, markdown: false });
    expect(JSON.parse((client.request as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toEqual({ article: { body: '<p>Raw</p>', draft: true } });
  });

  it('rejects an empty (no-op) update', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(updateArticle(client, cacheStub(), { articleId: 50, fields: { body: undefined }, markdown: true })).rejects.toThrow(/at least one field/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('re-maps a 403 to an actionable admin-required error', async () => {
    const client = { request: vi.fn().mockRejectedValue(new ZendeskPermissionError('Permission denied (scope ∩ role insufficient):')) } as unknown as ZendeskHttpClient;
    await expect(updateArticle(client, cacheStub(), { articleId: 50, fields: { title: 'x' }, markdown: true })).rejects.toThrow(/requires an admin role/i);
  });
});
