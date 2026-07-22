export interface CbpPage<T> {
  records: T[];
  meta: { has_more: boolean; after_cursor: string | null };
  links: { next: string | null };
}

export async function* paginateCbp<T>(
  fetchPage: (cursor: string | null) => Promise<CbpPage<T>>,
): AsyncGenerator<T[], void, void> {
  let cursor: string | null = null;
  let hasMore = true;
  while (hasMore) {
    const pageResult = await fetchPage(cursor);
    yield pageResult.records;
    hasMore = pageResult.meta.has_more;
    cursor = pageResult.meta.after_cursor;
    if (hasMore && !cursor) {
      throw new Error('CBP page reported has_more=true but no after_cursor was returned');
    }
  }
}

export async function collectAllCbp<T>(
  fetchPage: (cursor: string | null) => Promise<CbpPage<T>>,
): Promise<T[]> {
  const all: T[] = [];
  for await (const batch of paginateCbp(fetchPage)) {
    all.push(...batch);
  }
  return all;
}
