// src/tools/analytics/incremental.ts
// Incremental export readers (bulk sync). Two pagination shapes, both distinct from CBP:
//   - cursor-mode  (/incremental/{tickets,users}/cursor.json): after_cursor + end_of_stream
//   - time-mode    (/incremental/ticket_metric_events.json):   end_time + next_page, count<1000
// Every request is metered against the 10 req/min incremental bucket (rateClass:'incremental').
// Records are screened at ingest via summariseScreened before caching (readers in Tasks 6–8).

// Zendesk incremental export hard per-page maximum. A full page implies "more may exist".
const INCREMENTAL_PAGE_MAX = 1000;
const MAX_INCREMENTAL_PAGES = 10_000;

export const DEFAULT_INCREMENTAL_CAP = 1000; // default record ceiling for the standalone readers
export const MAX_INCREMENTAL_CAP = 10_000; // hard ceiling a caller may raise the cap to

export interface IncrementalCursorPage<T> {
  records: T[];
  after_cursor: string | null;
  end_of_stream: boolean;
}

export interface IncrementalTimePage<T> {
  records: T[];
  end_time: number | null;
  next_page: string | null;
  count: number;
}

// Cursor-mode: start_time on the first call, then the returned after_cursor, until end_of_stream.
export async function* paginateIncrementalCursor<T>(
  fetchPage: (params: { startTime?: number; cursor?: string }) => Promise<IncrementalCursorPage<T>>,
  startTime: number,
): AsyncGenerator<T[], void, void> {
  let cursor: string | undefined;
  let first = true;
  for (let pages = 0; ; pages++) {
    if (pages >= MAX_INCREMENTAL_PAGES) {
      throw new Error(`Incremental cursor export exceeded the ${MAX_INCREMENTAL_PAGES}-page cap.`);
    }
    const page = await fetchPage(first ? { startTime } : { cursor });
    first = false;
    yield page.records;
    if (page.end_of_stream) return;
    if (!page.after_cursor) {
      throw new Error('Incremental cursor page reported end_of_stream=false but no after_cursor was returned.');
    }
    cursor = page.after_cursor;
  }
}

// Time-mode: follow end_time as the next start_time until a non-full page (count < 1000) or a null
// next_page/end_time. Guards the poison-pill loop where end_time never advances on a full page.
export async function* paginateIncrementalTime<T>(
  fetchPage: (startTime: number) => Promise<IncrementalTimePage<T>>,
  startTime: number,
): AsyncGenerator<T[], void, void> {
  let start = startTime;
  for (let pages = 0; ; pages++) {
    if (pages >= MAX_INCREMENTAL_PAGES) {
      throw new Error(`Incremental time export exceeded the ${MAX_INCREMENTAL_PAGES}-page cap.`);
    }
    const page = await fetchPage(start);
    yield page.records;
    if (page.count < INCREMENTAL_PAGE_MAX || page.next_page === null || page.end_time === null) return;
    if (page.end_time <= start) {
      throw new Error('Incremental time export end_time did not advance — aborting to avoid an infinite loop.');
    }
    start = page.end_time;
  }
}

// Collect incremental pages into a single array, stopping once `cap` records are gathered so a
// reader can never accumulate an unbounded set into memory.
export async function collectIncremental<T>(gen: AsyncGenerator<T[], void, void>, cap: number): Promise<T[]> {
  const all: T[] = [];
  for await (const batch of gen) {
    all.push(...batch);
    if (all.length >= cap) break;
  }
  return all.slice(0, cap);
}
