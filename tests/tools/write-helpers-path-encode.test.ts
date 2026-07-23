// tests/tools/write-helpers-path-encode.test.ts
// Defense-in-depth (QA #2): updateEntity interpolates its id/locale into the URL path. A direct
// in-process caller passing a traversal id ("../../users/1") must NOT escape the intended
// collection — the segment is percent-encoded so it stays a single, inert path component. Not
// reachable via MCP (the register regex rejects it), but pinned here so the helper is safe alone.
import { describe, it, expect, vi } from 'vitest';
import { updateEntity } from '../../src/tools/write-helpers.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'h', path: '/x' }) } as unknown as ResponseCache;
}

describe('updateEntity path encoding', () => {
  it('percent-encodes a traversal locale/id so it cannot escape the collection path', async () => {
    const client = { request: vi.fn().mockResolvedValue({ translation: { id: 1 } }) } as unknown as ZendeskHttpClient;
    await updateEntity(
      client,
      cacheStub(),
      { collection: '/help_center/articles/5/translations', key: 'translation', toolName: 'zendesk_update_article_translation', resourceLabel: 'article translation' },
      '../../users/1',
      { title: 'x' },
      'standard',
    );
    const [path] = (client.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/help_center/articles/5/translations/..%2F..%2Fusers%2F1.json');
    // The raw traversal must not survive into the request path.
    expect(path).not.toContain('/../');
    expect(path).not.toContain('/users/1.json');
  });

  it('leaves a normal numeric id untouched', async () => {
    const client = { request: vi.fn().mockResolvedValue({ trigger: { id: 50 } }) } as unknown as ZendeskHttpClient;
    await updateEntity(
      client,
      cacheStub(),
      { collection: '/triggers', key: 'trigger', toolName: 'zendesk_update_trigger', resourceLabel: 'trigger' },
      50,
      { active: false },
      'standard',
    );
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/triggers/50.json');
  });
});
