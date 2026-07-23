// src/tools/analytics/report.ts
// Composite analytics report. This section is PURE (network-free): aggregation over
// already-screened records. The tool wrapper (Task 10) fetches + caches around it.
//   - volume: tickets created within the range.
//   - first-reply / resolution time: activate→fulfill metric-event intervals, reported BOTH
//     calendar (raw delta) and business (business-hours calculator).
//   - SLA breaches: metric events with type === 'breach', grouped by metric (data source stated).
//   - CSAT: good/bad counts + score% from satisfaction ratings.
import { z } from 'zod';
import { businessMinutesBetween, calendarMinutesBetween, type BusinessHoursConfig } from './business-hours.js';
import { summariseCsat, fetchRatings, DEFAULT_RATINGS_CAP, type CsatSummary } from './metrics.js';
import {
  fetchIncrementalCursor,
  fetchIncrementalTime,
  MetricEventSchema,
  DEFAULT_EVENTS_CAP,
  DEFAULT_INCREMENTAL_CAP,
  type MetricEvent,
} from './incremental.js';
import type { ZendeskHttpClient } from '../../client/http-client.js';
import type { ResponseCache } from '../../client/cache.js';
import type { SecurityLevel } from '../../security/screen.js';
import { makeDescribe, SCREEN_WARNING } from '../screening.js';
import type { ReadResult } from '../result.js';

export interface Interval {
  startMs: number;
  endMs: number;
}

export interface DurationStats {
  count: number;
  avgMinutes: number;
  minMinutes: number;
  maxMinutes: number;
  p50Minutes: number;
}

interface TimedEvent {
  type: 'activate' | 'fulfill';
  t: number;
}

// Pair a ticket's activate/fulfill events into closed intervals by walking them in time order:
// each activate opens an interval that the next fulfill closes. This keeps DISTINCT cycles on one
// ticket separate (activate→next fulfill) instead of collapsing them into one earliest→latest span
// that would inflate reply/resolution time. Used only when instance_id is absent to disambiguate.
function pairSequential(events: TimedEvent[]): Interval[] {
  const order = (type: TimedEvent['type']): number => (type === 'activate' ? 0 : 1);
  const sorted = [...events].sort((a, b) => a.t - b.t || order(a.type) - order(b.type));
  const out: Interval[] = [];
  let openStart: number | undefined;
  for (const e of sorted) {
    if (e.type === 'activate') {
      if (openStart === undefined) openStart = e.t; // ignore a second activate before any fulfill
    } else if (openStart !== undefined && e.t > openStart) {
      out.push({ startMs: openStart, endMs: e.t });
      openStart = undefined;
    }
  }
  return out;
}

// Pair activate→fulfill for one metric into closed intervals. Events carrying an instance_id are
// grouped per (ticket, instance) — Zendesk's own cycle key — as earliest activate / latest fulfill.
// Events WITHOUT an instance_id are paired sequentially per ticket so multiple cycles stay distinct.
// An activate with no matching fulfill is still open → excluded.
export function pairEventIntervals(events: MetricEvent[], metric: string): Interval[] {
  const instanced = new Map<string, { activate?: number; fulfill?: number }>();
  const sequential = new Map<number, TimedEvent[]>();
  for (const e of events) {
    if (e.metric !== metric) continue;
    if (e.type !== 'activate' && e.type !== 'fulfill') continue;
    const t = Date.parse(e.time);
    if (Number.isNaN(t)) continue;
    if (e.instance_id === undefined || e.instance_id === null) {
      const arr = sequential.get(e.ticket_id) ?? [];
      arr.push({ type: e.type, t });
      sequential.set(e.ticket_id, arr);
      continue;
    }
    const gkey = `${e.ticket_id}-${e.instance_id}`;
    const g = instanced.get(gkey) ?? {};
    if (e.type === 'activate') g.activate = g.activate === undefined ? t : Math.min(g.activate, t);
    else g.fulfill = g.fulfill === undefined ? t : Math.max(g.fulfill, t);
    instanced.set(gkey, g);
  }
  const out: Interval[] = [];
  for (const g of instanced.values()) {
    if (g.activate !== undefined && g.fulfill !== undefined && g.fulfill > g.activate) {
      out.push({ startMs: g.activate, endMs: g.fulfill });
    }
  }
  for (const evts of sequential.values()) out.push(...pairSequential(evts));
  return out;
}

// SLA-breach count — DATA SOURCE: ticket_metric_events with type === 'breach', grouped by metric
// (reply_time / resolution_time / …). This is the fixture-supported breach signal in the M6 inventory.
export function countBreaches(events: MetricEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.type === 'breach') out[e.metric] = (out[e.metric] ?? 0) + 1;
  }
  return out;
}

function stats(values: number[]): DurationStats {
  if (values.length === 0) return { count: 0, avgMinutes: 0, minMinutes: 0, maxMinutes: 0, p50Minutes: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mid = Math.floor(sorted.length / 2);
  // sorted.length ≥ 1 here, so sorted[0] / sorted[mid] indexing is guarded.
  const p50 = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    count: sorted.length,
    avgMinutes: Math.round(sum / sorted.length),
    minMinutes: sorted[0],
    maxMinutes: sorted[sorted.length - 1],
    p50Minutes: Math.round(p50),
  };
}

export interface DurationSummary {
  calendar: DurationStats;
  business: DurationStats;
}

export function summariseDurations(pairs: Interval[], config: BusinessHoursConfig): DurationSummary {
  const calendar = stats(pairs.map((p) => calendarMinutesBetween(p.startMs, p.endMs)));
  const business = stats(pairs.map((p) => businessMinutesBetween(p.startMs, p.endMs, config)));
  return { calendar, business };
}

export interface ReportInput {
  tickets: { id: number; created_at?: string | null }[];
  events: MetricEvent[];
  ratings: { score: string }[];
  rangeStartMs: number;
  rangeEndMs: number;
  config: BusinessHoursConfig;
}

export interface Report {
  volume: number;
  firstReplyTime: DurationSummary;
  resolutionTime: DurationSummary;
  slaBreaches: Record<string, number>;
  slaBreachTotal: number;
  csat: CsatSummary;
}

// Range membership is half-open [start, end): an instant at exactly rangeEndMs belongs to the NEXT
// range, so adjacent report windows never double-count the same boundary event.
function inRange(iso: string | null | undefined, startMs: number, endMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= startMs && t < endMs;
}

function pairsInRange(pairs: Interval[], startMs: number, endMs: number): Interval[] {
  // A pair is attributed to the range by its activate (start) instant, half-open [start, end).
  return pairs.filter((p) => p.startMs >= startMs && p.startMs < endMs);
}

export function buildReport(input: ReportInput): Report {
  const volume = input.tickets.filter((t) => inRange(t.created_at, input.rangeStartMs, input.rangeEndMs)).length;
  const frt = pairsInRange(pairEventIntervals(input.events, 'reply_time'), input.rangeStartMs, input.rangeEndMs);
  const res = pairsInRange(pairEventIntervals(input.events, 'resolution_time'), input.rangeStartMs, input.rangeEndMs);
  const eventsInRange = input.events.filter((e) => inRange(e.time, input.rangeStartMs, input.rangeEndMs));
  const slaBreaches = countBreaches(eventsInRange);
  const slaBreachTotal = Object.values(slaBreaches).reduce((acc, n) => acc + n, 0);
  return {
    volume,
    firstReplyTime: summariseDurations(frt, input.config),
    resolutionTime: summariseDurations(res, input.config),
    slaBreaches,
    slaBreachTotal,
    csat: summariseCsat(input.ratings),
  };
}

export function renderReport(report: Report, startTime: number, endTime: number): string {
  const dur = (s: DurationStats): string => `avg ${s.avgMinutes}m · p50 ${s.p50Minutes}m · min ${s.minMinutes}m · max ${s.maxMinutes}m (n=${s.count})`;
  const breachLines = Object.entries(report.slaBreaches).map(([m, n]) => `  - ${m}: ${n}`);
  const breaches = breachLines.length > 0 ? breachLines.join('\n') : '  - none';
  const csat = report.csat.scorePct === null ? 'no rated responses' : `${report.csat.scorePct}% (${report.csat.good} good / ${report.csat.bad} bad)`;
  return [
    `Zendesk report — ${new Date(startTime * 1000).toISOString()} → ${new Date(endTime * 1000).toISOString()}`,
    `Ticket volume (created in range): ${report.volume}`,
    `First reply time — calendar: ${dur(report.firstReplyTime.calendar)}`,
    `First reply time — business: ${dur(report.firstReplyTime.business)}`,
    `Resolution time — calendar: ${dur(report.resolutionTime.calendar)}`,
    `Resolution time — business: ${dur(report.resolutionTime.business)}`,
    `SLA breaches (total ${report.slaBreachTotal}):`,
    breaches,
    `CSAT: ${csat}`,
  ].join('\n');
}

// ---- zendesk_report (composite) ----

const ReportTicketSchema = z.object({ id: z.number(), subject: z.string().nullish(), created_at: z.string().nullish() });
type ReportTicket = z.infer<typeof ReportTicketSchema>;

// subject is in ALWAYS_FENCE → wrapped unconditionally at ingest.
const describeReportTicket = makeDescribe<ReportTicket>('report-ticket', (t) => `#${t.id} ${t.subject ?? '(no subject)'}`);
const describeReportEvent = makeDescribe<MetricEvent>('report-event', (e) => `#${e.id} ${e.metric}/${e.type}`);

export async function report(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { startTime: number; endTime?: number; maxRecords?: number },
  securityLevel: SecurityLevel = 'standard',
  config: BusinessHoursConfig,
  nowMs: number = Date.now(),
): Promise<ReadResult> {
  if (!Number.isInteger(params.startTime) || params.startTime <= 0) {
    throw new Error('zendesk_report requires a positive unix-seconds start_time.');
  }
  const endTime = params.endTime ?? Math.floor(nowMs / 1000);
  if (endTime < params.startTime) {
    throw new Error(`zendesk_report end_time (${endTime}) must be greater than or equal to start_time (${params.startTime}).`);
  }
  const rangeStartMs = params.startTime * 1000;
  const rangeEndMs = endTime * 1000;

  // All pulls screen at ingest via the reused fetch layer (identical to the standalone readers).
  const ticketsS = await fetchIncrementalCursor<ReportTicket>({
    client, path: '/incremental/tickets/cursor.json', key: 'tickets', schema: ReportTicketSchema,
    describe: describeReportTicket, startTime: params.startTime, cap: DEFAULT_INCREMENTAL_CAP, securityLevel, errorLabel: '/incremental/tickets',
  });
  const eventsS = await fetchIncrementalTime<MetricEvent>({
    client, path: '/incremental/ticket_metric_events.json', key: 'ticket_metric_events', schema: MetricEventSchema,
    describe: describeReportEvent, startTime: params.startTime, cap: DEFAULT_EVENTS_CAP, securityLevel, errorLabel: '/incremental/ticket_metric_events',
  });
  const ratingsS = await fetchRatings(client, { startTime: params.startTime, cap: DEFAULT_RATINGS_CAP }, securityLevel);

  const built = buildReport({
    tickets: ticketsS.records,
    events: eventsS.records,
    ratings: ratingsS.records,
    rangeStartMs,
    rangeEndMs,
    config,
  });
  const flagged = ticketsS.flagged || eventsS.flagged || ratingsS.flagged;
  const entry = cache.save('zendesk_report', {
    tickets: ticketsS.records,
    ticket_metric_events: eventsS.records,
    satisfaction_ratings: ratingsS.records,
    report: built,
  });
  return {
    summary: `${renderReport(built, params.startTime, endTime)}${flagged ? SCREEN_WARNING : ''}`,
    cacheHandle: entry.handle,
    flagged,
  };
}
