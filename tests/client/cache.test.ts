import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
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

  it('treats an entry older than the TTL as missing and reaps it', () => {
    const cache = new ResponseCache(dir, { ttlMs: 60_000 });
    const entry = cache.save('zendesk_get_ticket', { ticket: { id: 1 } });
    expect(cache.load(entry.handle)).toBeDefined();
    // Backdate the file's mtime beyond the TTL — the next load must reject it as expired.
    const stale = new Date(Date.now() - 120_000);
    utimesSync(entry.path, stale, stale);
    expect(() => cache.load(entry.handle)).toThrow(/not found/i);
  });

  it('evicts the oldest entries on write once the total-size cap is exceeded', () => {
    // Each payload is ~30 bytes on disk; a 50-byte cap fits one but not two.
    const cache = new ResponseCache(dir, { maxBytes: 50 });
    const first = cache.save('zendesk_get_ticket', { d: 'aaaaaaaaaaaaaaaaaaaa' });
    // Make `first` unambiguously the oldest, then a second write pushes past the cap.
    const old = new Date(Date.now() - 1000);
    utimesSync(first.path, old, old);
    const second = cache.save('zendesk_get_ticket', { d: 'bbbbbbbbbbbbbbbbbbbb' });
    expect(() => cache.load(first.handle)).toThrow(/not found/i);
    expect(cache.load(second.handle)).toBeDefined();
  });
});
