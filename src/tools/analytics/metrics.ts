// src/tools/analytics/metrics.ts
// Analytics reads: ticket metrics (per-ticket reply/resolution timings) and CSAT satisfaction
// ratings. All READ. Records are screened at ingest before caching. Ticket metrics carry no free
// text (numeric timings + ids) but still route through the field-agnostic deep screen; rating
// comments ARE attacker-authored free text and are fenced explicitly (describeRating below).
import { z } from 'zod';
import type { ZendeskHttpClient } from '../../client/http-client.js';
import type { ResponseCache } from '../../client/cache.js';
import type { SecurityLevel } from '../../security/screen.js';
import {
  makeScreener,
  screenRecordDeep,
  makeDescribe,
  summariseScreened,
  SCREEN_WARNING,
  type RecordScreen,
  type Screener,
  type ScreenedSummary,
} from '../screening.js';
import { listCbp, DEFAULT_LIST_CAP, MAX_PAGE_SIZE } from '../cbp-list.js';
import { cbpPageSchema, collectCbp, type CbpPage } from '../../client/paginator.js';
import type { ReadResult } from '../result.js';

const MinutesPairSchema = z.object({ calendar: z.number().nullish(), business: z.number().nullish() }).nullish();

const TicketMetricSchema = z.object({
  id: z.number(),
  ticket_id: z.number().nullish(),
  reply_time_in_minutes: MinutesPairSchema,
  first_resolution_time_in_minutes: MinutesPairSchema,
  full_resolution_time_in_minutes: MinutesPairSchema,
  created_at: z.string().nullish(),
  solved_at: z.string().nullish(),
});
export type TicketMetric = z.infer<typeof TicketMetricSchema>;

const cal = (p: { calendar?: number | null } | null | undefined): string => String(p?.calendar ?? '—');

const describeMetric = makeDescribe<TicketMetric>(
  'ticket-metric',
  (m) => `#${m.id} ticket ${m.ticket_id ?? '?'} reply(cal ${cal(m.reply_time_in_minutes)}m) resolution(cal ${cal(m.full_resolution_time_in_minutes)}m)`,
);

const SingleTicketMetricSchema = z.object({ ticket_metric: TicketMetricSchema });

export async function ticketMetrics(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { ticketId?: number; pageSize?: number; maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  if (params.ticketId !== undefined) {
    const raw = await client.request<unknown>(`/tickets/${params.ticketId}/metrics.json`);
    const parsed = SingleTicketMetricSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unexpected /tickets/{id}/metrics response shape.');
    const { value, flagged } = screenRecordDeep(parsed.data, (key) => `ticket-metric-${params.ticketId}-${key}`, makeScreener(securityLevel));
    const safe = value as { ticket_metric: TicketMetric };
    const entry = cache.save('zendesk_ticket_metrics', safe);
    return {
      summary: `Ticket metric #${safe.ticket_metric.id} for ticket ${params.ticketId} — reply(cal ${cal(safe.ticket_metric.reply_time_in_minutes)}m), resolution(cal ${cal(safe.ticket_metric.full_resolution_time_in_minutes)}m)${flagged ? SCREEN_WARNING : ''}`,
      cacheHandle: entry.handle,
      flagged,
    };
  }
  return listCbp<TicketMetric>({
    client,
    cache,
    securityLevel,
    path: '/ticket_metrics.json',
    key: 'ticket_metrics',
    schema: TicketMetricSchema,
    describe: describeMetric,
    handle: 'zendesk_ticket_metrics',
    cap: Math.min(params.maxRecords ?? DEFAULT_LIST_CAP, DEFAULT_LIST_CAP),
    pageSize: params.pageSize,
    label: (n) => `${n} ticket metric(s)`,
    errorLabel: '/ticket_metrics',
  });
}

// ---- CSAT: satisfaction ratings ----

export const DEFAULT_RATINGS_CAP = 1000;
export const MAX_RATINGS_CAP = 10_000;

const RatingSchema = z.object({
  id: z.number(),
  score: z.string(),
  comment: z.string().nullish(),
  created_at: z.string().nullish(),
  ticket_id: z.number().nullish(),
  assignee_id: z.number().nullish(),
});
export type SatisfactionRating = z.infer<typeof RatingSchema>;

// The rating comment is attacker-authored free text but is NOT in the global ALWAYS_FENCE set, so
// fence it explicitly ONCE: screen the ORIGINAL comment to WRAP it (and flag any injection)
// unconditionally, then overwrite the deep-screened copy's comment with that single wrapping — the
// deep screen would otherwise wrap a flagged comment a second time (double-fence). Immutable —
// build a new record rather than mutating the deep copy.
export function describeRating(rating: SatisfactionRating, screen: Screener): RecordScreen<SatisfactionRating> {
  const deep = screenRecordDeep(rating, (key) => `rating-${rating.id}-${key}`, screen);
  const base = deep.value as SatisfactionRating;
  const commentScreen =
    typeof rating.comment === 'string' && rating.comment !== '' ? screen(rating.comment, `rating-${rating.id}-comment`) : null;
  const safe: SatisfactionRating = commentScreen ? { ...base, comment: commentScreen.wrapped } : base;
  const flagged = deep.flagged || (commentScreen?.flagged ?? false);
  return { safe, line: `#${safe.id} ${safe.score}${safe.comment ? ' (comment)' : ''}`, flagged };
}

// Fetch + screen satisfaction ratings via CBP. Returns the screened batch so both the standalone
// tool and zendesk_report reuse identical screening. start_time filters server-side when given.
export async function fetchRatings(
  client: ZendeskHttpClient,
  params: { startTime?: number; cap: number },
  securityLevel: SecurityLevel,
): Promise<ScreenedSummary<SatisfactionRating>> {
  const pageSchema = cbpPageSchema(RatingSchema, 'satisfaction_ratings');
  const fetchPage = async (cursor: string | null): Promise<CbpPage<SatisfactionRating>> => {
    const parts = [`page[size]=${MAX_PAGE_SIZE}`];
    if (params.startTime !== undefined) parts.push(`start_time=${params.startTime}`);
    if (cursor) parts.push(`page[after]=${encodeURIComponent(cursor)}`);
    const raw = await client.request<unknown>(`/satisfaction_ratings.json?${parts.join('&')}`);
    const parsed = pageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unexpected /satisfaction_ratings response shape.');
    const data = parsed.data as Record<string, unknown>;
    const meta = data.meta as CbpPage<SatisfactionRating>['meta'];
    const links = data.links as { next: string | null } | null | undefined;
    return { records: data.satisfaction_ratings as SatisfactionRating[], meta, links: { next: links?.next ?? null } };
  };
  const collected = await collectCbp(fetchPage, params.cap);
  return summariseScreened(collected, describeRating, securityLevel);
}

export async function satisfactionRatings(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { startTime?: number; maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const cap = Math.min(params.maxRecords ?? DEFAULT_RATINGS_CAP, MAX_RATINGS_CAP);
  const screened = await fetchRatings(client, { startTime: params.startTime, cap }, securityLevel);
  const entry = cache.save('zendesk_satisfaction_ratings', { satisfaction_ratings: screened.records });
  return {
    summary: `${screened.records.length} satisfaction rating(s):\n${screened.lines.join('\n')}${screened.warning}`,
    cacheHandle: entry.handle,
    flagged: screened.flagged,
  };
}

export interface CsatSummary {
  good: number;
  bad: number;
  rated: number; // good + bad (offered/unoffered excluded from the score denominator)
  scorePct: number | null; // good / rated, rounded; null when nothing is rated
}

export function summariseCsat(ratings: { score: string }[]): CsatSummary {
  let good = 0;
  let bad = 0;
  for (const r of ratings) {
    if (r.score === 'good') good += 1;
    else if (r.score === 'bad') bad += 1;
  }
  const rated = good + bad;
  return { good, bad, rated, scorePct: rated === 0 ? null : Math.round((good / rated) * 100) };
}
