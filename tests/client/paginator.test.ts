import { describe, it, expect } from 'vitest';
import { paginateCbp, collectAllCbp, type CbpPage } from '../../src/client/paginator.js';

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

  it('collectAllCbp flattens all pages into one array', async () => {
    const pages = [page([1, 2], true, 'cursor-1'), page([3, 4], false, null)];
    let call = 0;
    const fetchPage = async () => pages[call++];
    const all = await collectAllCbp(fetchPage);
    expect(all).toEqual([1, 2, 3, 4]);
  });

  it('throws if has_more is true but after_cursor is missing (malformed response)', async () => {
    const fetchPage = async () => page([1], true, null);
    await expect(collectAllCbp(fetchPage)).rejects.toThrow(/has_more.*after_cursor/i);
  });
});
