// src/tools/analytics/incremental.ts
// Incremental export readers (bulk sync). Two pagination shapes, both distinct from CBP:
//   - cursor-mode  (/incremental/{tickets,users}/cursor.json): after_cursor + end_of_stream
//   - time-mode    (/incremental/ticket_metric_events.json):   end_time + next_page, count<1000
// Every request is metered against the 10 req/min incremental bucket (rateClass:'incremental').
// Records are screened at ingest via summariseScreened before caching.
import { z } from 'zod';
import type { ZendeskHttpClient } from '../../client/http-client.js';
import type { ResponseCache } from '../../client/cache.js';
import type { SecurityLevel } from '../../security/screen.js';
import {
  makeDescribe,
  summariseScreened,
  type RecordScreen,
  type Screener,
  type ScreenedSummary,
} from '../screening.js';
import type { ReadResult } from '../result.js';

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

// ---- Generic cursor reader (paginate cursor-mode + screen) ----

// Validate start_time once for every incremental reader: a positive unix-seconds integer.
function assertStartTime(startTime: number): void {
  if (!Number.isInteger(startTime) || startTime <= 0) {
    throw new Error('Incremental export requires a positive unix-seconds start_time.');
  }
}

export interface IncrementalCursorConfig<T extends { id: number }> {
  client: ZendeskHttpClient;
  path: string; // e.g. '/incremental/tickets/cursor.json'
  key: string; // envelope array key, e.g. 'tickets'
  schema: z.ZodType<T>;
  describe: (record: T, screen: Screener) => RecordScreen<T>;
  startTime: number;
  cap: number;
  securityLevel: SecurityLevel;
  errorLabel: string; // e.g. '/incremental/tickets'
}

export async function fetchIncrementalCursor<T extends { id: number }>(
  config: IncrementalCursorConfig<T>,
): Promise<ScreenedSummary<T>> {
  assertStartTime(config.startTime);
  const pageSchema = z
    .object({ after_cursor: z.string().nullable(), end_of_stream: z.boolean() })
    .extend({ [config.key]: z.array(config.schema) } as Record<string, z.ZodTypeAny>);
  const fetchPage = async (params: { startTime?: number; cursor?: string }): Promise<IncrementalCursorPage<T>> => {
    const query = params.cursor !== undefined ? `cursor=${encodeURIComponent(params.cursor)}` : `start_time=${params.startTime}`;
    const raw = await config.client.request<unknown>(`${config.path}?${query}`, {}, { rateClass: 'incremental' });
    const parsed = pageSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Unexpected ${config.errorLabel} response shape.`);
    const data = parsed.data as Record<string, unknown>;
    return {
      records: data[config.key] as T[],
      after_cursor: data.after_cursor as string | null,
      end_of_stream: data.end_of_stream as boolean,
    };
  };
  const collected = await collectIncremental(paginateIncrementalCursor(fetchPage, config.startTime), config.cap);
  return summariseScreened(collected, config.describe, config.securityLevel);
}

// ---- zendesk_incremental_tickets ----

const IncTicketSchema = z.object({
  id: z.number(),
  subject: z.string().nullish(),
  status: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  requester_id: z.number().nullish(),
});
export type IncrementalTicket = z.infer<typeof IncTicketSchema>;

// subject is in ALWAYS_FENCE → wrapped unconditionally by the deep screen.
const describeIncTicket = makeDescribe<IncrementalTicket>(
  'inc-ticket',
  (t) => `#${t.id} [${t.status ?? '?'}] ${t.subject ?? '(no subject)'}`,
);

export async function incrementalTickets(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { startTime: number; maxRecords?: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const cap = Math.min(params.maxRecords ?? DEFAULT_INCREMENTAL_CAP, MAX_INCREMENTAL_CAP);
  const screened = await fetchIncrementalCursor<IncrementalTicket>({
    client,
    path: '/incremental/tickets/cursor.json',
    key: 'tickets',
    schema: IncTicketSchema,
    describe: describeIncTicket,
    startTime: params.startTime,
    cap,
    securityLevel,
    errorLabel: '/incremental/tickets',
  });
  const entry = cache.save('zendesk_incremental_tickets', { tickets: screened.records });
  return {
    summary: `${screened.records.length} ticket(s) since ${new Date(params.startTime * 1000).toISOString()}:\n${screened.lines.join('\n')}${screened.warning}`,
    cacheHandle: entry.handle,
    flagged: screened.flagged,
  };
}
