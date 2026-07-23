// src/tools/analytics/report.ts
// Composite analytics report. This section is PURE (network-free): aggregation over
// already-screened records. The tool wrapper (Task 10) fetches + caches around it.
//   - volume: tickets created within the range.
//   - first-reply / resolution time: activate→fulfill metric-event intervals, reported BOTH
//     calendar (raw delta) and business (business-hours calculator).
//   - SLA breaches: metric events with type === 'breach', grouped by metric (data source stated).
//   - CSAT: good/bad counts + score% from satisfaction ratings.
import { businessMinutesBetween, calendarMinutesBetween, type BusinessHoursConfig } from './business-hours.js';
import { summariseCsat, type CsatSummary } from './metrics.js';
import type { MetricEvent } from './incremental.js';

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

// Pair activate→fulfill per (ticket, instance) for one metric into closed intervals. A group with
// an activate but no fulfill is still open → excluded. Earliest activate / latest fulfill win.
export function pairDurations(events: MetricEvent[], metric: string): Interval[] {
  const groups = new Map<string, { activate?: number; fulfill?: number }>();
  for (const e of events) {
    if (e.metric !== metric) continue;
    if (e.type !== 'activate' && e.type !== 'fulfill') continue;
    const t = Date.parse(e.time);
    if (Number.isNaN(t)) continue;
    const gkey = `${e.ticket_id}-${e.instance_id ?? 0}`;
    const g = groups.get(gkey) ?? {};
    if (e.type === 'activate') g.activate = g.activate === undefined ? t : Math.min(g.activate, t);
    else g.fulfill = g.fulfill === undefined ? t : Math.max(g.fulfill, t);
    groups.set(gkey, g);
  }
  const out: Interval[] = [];
  for (const g of groups.values()) {
    if (g.activate !== undefined && g.fulfill !== undefined && g.fulfill > g.activate) {
      out.push({ startMs: g.activate, endMs: g.fulfill });
    }
  }
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

function inRange(iso: string | null | undefined, startMs: number, endMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= startMs && t <= endMs;
}

function pairsInRange(pairs: Interval[], startMs: number, endMs: number): Interval[] {
  // A pair is attributed to the range by its activate (start) instant.
  return pairs.filter((p) => p.startMs >= startMs && p.startMs <= endMs);
}

export function buildReport(input: ReportInput): Report {
  const volume = input.tickets.filter((t) => inRange(t.created_at, input.rangeStartMs, input.rangeEndMs)).length;
  const frt = pairsInRange(pairDurations(input.events, 'reply_time'), input.rangeStartMs, input.rangeEndMs);
  const res = pairsInRange(pairDurations(input.events, 'resolution_time'), input.rangeStartMs, input.rangeEndMs);
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
