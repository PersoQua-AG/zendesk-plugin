import { describe, it, expect } from 'vitest';
import { paginateCbp, collectCbp, cbpPageSchema, type CbpPage } from '../../src/client/paginator.js';
import { z } from 'zod';

function page(records: number[], hasMore: boolean, afterCursor: string | null): CbpPage<number> {
  return { records, meta: { has_more: hasMore, after_cursor: afterCursor }, links: { next: null } };
}

describe('CBP paginator', () => {
  it('yields each page in order and stops when has_more is false', async () => {
    const pages = [page([1, 2], true, 'cursor-1'), page([3], false, null)];
    let call = 0;
    const fetchPage = async (cursor: string | null) => {
      expect(cursor).toBe(call === 0 ? null : 'cursor-1');
      return pages[call++];
    };

    const batches: number[][] = [];
    for await (const batch of paginateCbp(fetchPage)) {
      batches.push(batch);
    }
    expect(batches).toEqual([[1, 2], [3]]);
  });

  it('collectCbp flattens all pages into one array', async () => {
    const pages = [page([1, 2], true, 'cursor-1'), page([3, 4], false, null)];
    let call = 0;
    const fetchPage = async () => pages[call++];
    const all = await collectCbp(fetchPage, 100);
    expect(all).toEqual([1, 2, 3, 4]);
  });

  it('collectCbp stops at the cap even when more pages exist', async () => {
    const fetchPage = async () => page([1, 2, 3], true, 'cursor-next');
    const all = await collectCbp(fetchPage, 2);
    expect(all).toEqual([1, 2]);
  });

  it('throws if has_more is true but after_cursor is missing (malformed response)', async () => {
    const fetchPage = async () => page([1], true, null);
    await expect(collectCbp(fetchPage, 100)).rejects.toThrow(/has_more.*after_cursor/i);
  });

  it('aborts with a clear error if the API never stops advertising has_more', async () => {
    // Always returns a valid next cursor — without a cap this would loop forever.
    let n = 0;
    const fetchPage = async () => page([n], true, `cursor-${n++}`);
    await expect(collectCbp(fetchPage, Number.MAX_SAFE_INTEGER)).rejects.toThrow(/page cap/i);
  });
});

describe('cbpPageSchema', () => {
  it('validates a keyed page envelope and exposes the typed records array', () => {
    const schema = cbpPageSchema(z.object({ id: z.number() }), 'tickets');
    const parsed = schema.safeParse({
      tickets: [{ id: 1 }, { id: 2 }],
      meta: { has_more: false, after_cursor: null },
      links: { next: null },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tickets).toEqual([{ id: 1 }, { id: 2 }]);
      expect(parsed.data.meta.has_more).toBe(false);
    }
  });

  it('rejects a payload missing the keyed array', () => {
    const schema = cbpPageSchema(z.object({ id: z.number() }), 'tickets');
    expect(schema.safeParse({ meta: { has_more: false, after_cursor: null } }).success).toBe(false);
  });
});
