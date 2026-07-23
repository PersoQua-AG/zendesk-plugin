// tests/tools/analytics-incremental-paginator.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  paginateIncrementalCursor,
  paginateIncrementalTime,
  collectIncremental,
  type IncrementalCursorPage,
  type IncrementalTimePage,
} from '../../src/tools/analytics/incremental.js';

async function drain<T>(gen: AsyncGenerator<T[], void, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const batch of gen) out.push(...batch);
  return out;
}

describe('paginateIncrementalCursor', () => {
  it('sends start_time first, then cursor, until end_of_stream', async () => {
    const fetchPage = vi
      .fn<[{ startTime?: number; cursor?: string }], Promise<IncrementalCursorPage<number>>>()
      .mockResolvedValueOnce({ records: [1, 2], after_cursor: 'c1', end_of_stream: false })
      .mockResolvedValueOnce({ records: [3], after_cursor: 'c2', end_of_stream: true });
    const all = await drain(paginateIncrementalCursor(fetchPage, 1000));
    expect(all).toEqual([1, 2, 3]);
    expect(fetchPage.mock.calls[0][0]).toEqual({ startTime: 1000 });
    expect(fetchPage.mock.calls[1][0]).toEqual({ cursor: 'c1' });
  });

  it('throws when end_of_stream=false but after_cursor is null', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ records: [], after_cursor: null, end_of_stream: false });
    await expect(drain(paginateIncrementalCursor(fetchPage, 1))).rejects.toThrow(/no after_cursor/i);
  });
});

describe('paginateIncrementalTime', () => {
  it('follows end_time until count < 1000', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => i);
    const fetchPage = vi
      .fn<[number], Promise<IncrementalTimePage<number>>>()
      .mockResolvedValueOnce({ records: full, end_time: 2000, next_page: 'p2', count: 1000 })
      .mockResolvedValueOnce({ records: [1, 2], end_time: 3000, next_page: null, count: 2 });
    const all = await drain(paginateIncrementalTime(fetchPage, 1000));
    expect(all).toHaveLength(1002);
    expect(fetchPage.mock.calls[0][0]).toBe(1000);
    expect(fetchPage.mock.calls[1][0]).toBe(2000);
  });

  it('throws when end_time fails to advance on a full page', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => i);
    const fetchPage = vi.fn().mockResolvedValue({ records: full, end_time: 1000, next_page: 'p', count: 1000 });
    await expect(drain(paginateIncrementalTime(fetchPage, 1000))).rejects.toThrow(/did not advance/i);
  });
});

describe('collectIncremental', () => {
  it('stops at the cap even when more pages exist', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ records: [1, 2, 3], after_cursor: 'c', end_of_stream: false });
    const collected = await collectIncremental(paginateIncrementalCursor(fetchPage, 1), 2);
    expect(collected).toEqual([1, 2]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
