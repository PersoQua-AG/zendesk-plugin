import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResponseCache } from '../../src/client/cache.js';

describe('ResponseCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zd-cache-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves a response and returns a unique handle', () => {
    const cache = new ResponseCache(dir);
    const entry1 = cache.save('zendesk_list_tickets', { tickets: [{ id: 1 }] });
    const entry2 = cache.save('zendesk_list_tickets', { tickets: [{ id: 2 }] });
    expect(entry1.handle).not.toBe(entry2.handle);
    expect(entry1.handle).toContain('zendesk_list_tickets');
  });

  it('loads back exactly what was saved', () => {
    const cache = new ResponseCache(dir);
    const data = { tickets: [{ id: 1, subject: 'Help' }] };
    const entry = cache.save('zendesk_list_tickets', data);
    expect(cache.load(entry.handle)).toEqual(data);
  });

  it('throws a clear error for an unknown handle', () => {
    const cache = new ResponseCache(dir);
    expect(() => cache.load('does-not-exist')).toThrow(/not found/i);
  });

  it('rejects a path-traversal handle instead of reading outside the cache dir', () => {
    const cache = new ResponseCache(dir);
    // A handle escaping the cache dir must be refused before any filesystem read.
    expect(() => cache.load('../../../../etc/passwd')).toThrow(/invalid cache handle/i);
    expect(() => cache.load('..%2f..%2fsecret')).toThrow(/invalid cache handle/i);
    expect(() => cache.load('foo/bar')).toThrow(/invalid cache handle/i);
  });
});
