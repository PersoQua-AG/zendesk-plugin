import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResponseCache } from '../../src/client/cache.js';
import { modeBitsIgnored } from '../setup/mode-bits.js';

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

  // #54: the constructor, not the first save(), must reject a cache dir it cannot write. chmod is
  // not enforced for root, so under root the directory would stay writable and prove nothing.
  it.skipIf(modeBitsIgnored)('throws EACCES at construction for an existing read-only directory', () => {
    const readOnly = join(dir, 'cache');
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    try {
      let code: unknown;
      try {
        new ResponseCache(readOnly);
      } catch (err) {
        code = (err as NodeJS.ErrnoException).code;
      }
      expect(code).toBe('EACCES');
    } finally {
      chmodSync(readOnly, 0o700);
    }
  });

  // sweep() reads the directory on every save, so write+traverse alone is not enough to use it.
  it.skipIf(modeBitsIgnored)('throws EACCES at construction for a write-only directory (0300)', () => {
    const writeOnly = join(dir, 'cache-0300');
    mkdirSync(writeOnly);
    chmodSync(writeOnly, 0o300);
    try {
      let code: unknown;
      try {
        new ResponseCache(writeOnly);
      } catch (err) {
        code = (err as NodeJS.ErrnoException).code;
      }
      expect(code).toBe('EACCES');
    } finally {
      chmodSync(writeOnly, 0o700);
    }
  });

  // The constructor's check goes stale (ENOSPC, EROFS, a quota, plain TOCTOU). save() must still
  // not hand Node's raw error — which carries the absolute path — to the tool result.
  it.skipIf(modeBitsIgnored)('reports a write failure by code, without the path', () => {
    const cache = new ResponseCache(dir);
    chmodSync(dir, 0o500); // becomes unwritable AFTER construction succeeded
    try {
      let message = '';
      try {
        cache.save('zendesk_get_me', { a: 1 });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('EACCES');
      expect(message).toMatch(/free space/);
      expect(message).not.toContain(dir);
      expect(message).not.toContain('.json');
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  // The sanitized message is for the model; the diagnosable original must not be thrown away.
  it.skipIf(modeBitsIgnored)('keeps the original fs error as the cause', () => {
    const cache = new ResponseCache(dir);
    chmodSync(dir, 0o500);
    try {
      let cause: unknown;
      try {
        cache.save('zendesk_get_me', { a: 1 });
      } catch (err) {
        cause = (err as Error).cause;
      }
      expect((cause as NodeJS.ErrnoException | undefined)?.code).toBe('EACCES');
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  // 0300 is write+traverse without read: the write lands, sweep()'s readdirSync throws. The entry
  // is on disk, so the caller must still get its handle instead of a "caching failed" error.
  it.skipIf(modeBitsIgnored)('returns the handle when only the sweep fails', () => {
    const cache = new ResponseCache(dir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chmodSync(dir, 0o300);
    try {
      const entry = cache.save('zendesk_get_me', { a: 1 });
      expect(entry.handle).toMatch(/^zendesk_get_me-/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
    } finally {
      chmodSync(dir, 0o700);
      warn.mockRestore();
    }
  });
});
