export interface CbpPage<T> {
  records: T[];
  meta: { has_more: boolean; after_cursor: string | null };
  links: { next: string | null };
}

const MAX_PAGES = 10_000;

export async function* paginateCbp<T>(
  fetchPage: (cursor: string | null) => Promise<CbpPage<T>>,
): AsyncGenerator<T[], void, void> {
  let cursor: string | null = null;
  let hasMore = true;
  let pages = 0;
  while (hasMore) {
    if (pages >= MAX_PAGES) {
      throw new Error(`CBP pagination exceeded the ${MAX_PAGES}-page cap — aborting to avoid an infinite loop`);
    }
    const pageResult = await fetchPage(cursor);
    pages += 1;
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
