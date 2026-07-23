// src/tools/analytics/metrics.ts
// Analytics reads: ticket metrics (per-ticket reply/resolution timings) and CSAT satisfaction
// ratings. All READ. Records are screened at ingest before caching. Ticket metrics carry no free
// text (numeric timings + ids) but still route through the field-agnostic deep screen; rating
// comments ARE attacker-authored free text and are fenced explicitly (describeRating below).
import { z } from 'zod';
import type { ZendeskHttpClient } from '../../client/http-client.js';
import type { ResponseCache } from '../../client/cache.js';
import type { SecurityLevel } from '../../security/screen.js';
import { makeScreener, screenRecordDeep, makeDescribe, SCREEN_WARNING } from '../screening.js';
import { listCbp, DEFAULT_LIST_CAP } from '../cbp-list.js';
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

const cal = (p: { calendar?: number | null } | null | undefined): string =>
  (p?.calendar ?? null) === null ? '—' : String(p!.calendar);

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
