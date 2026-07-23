// tests/tools/analytics-report-aggregation.test.ts
import { describe, it, expect } from 'vitest';
import { pairDurations, countBreaches, summariseDurations, buildReport, renderReport } from '../../src/tools/analytics/report.js';
import type { MetricEvent } from '../../src/tools/analytics/incremental.js';
import type { BusinessHoursConfig } from '../../src/tools/analytics/business-hours.js';

const BERLIN: BusinessHoursConfig = { timeZone: 'Europe/Berlin', workHours: { start: '09:00', end: '17:00' }, workdays: [1, 2, 3, 4, 5] };

const ev = (id: number, ticket: number, metric: string, type: string, time: string, instance = 1): MetricEvent => ({
  id, ticket_id: ticket, metric, instance_id: instance, type, time,
});

describe('pairDurations', () => {
  it('pairs activate→fulfill per ticket/instance for the target metric', () => {
    const events: MetricEvent[] = [
      ev(1, 42, 'reply_time', 'activate', '2026-07-01T09:00:00Z'),
      ev(2, 42, 'reply_time', 'fulfill', '2026-07-01T09:30:00Z'),
      ev(3, 43, 'reply_time', 'activate', '2026-07-01T10:00:00Z'), // no fulfill → excluded
      ev(4, 42, 'resolution_time', 'activate', '2026-07-01T09:00:00Z'), // other metric → excluded
    ];
    const pairs = pairDurations(events, 'reply_time');
    expect(pairs).toHaveLength(1);
    expect(pairs[0].endMs - pairs[0].startMs).toBe(30 * 60_000);
  });
});

describe('countBreaches', () => {
  it('counts breach events grouped by metric', () => {
    const events: MetricEvent[] = [
      ev(1, 42, 'reply_time', 'breach', '2026-07-01T09:00:00Z'),
      ev(2, 43, 'reply_time', 'breach', '2026-07-01T10:00:00Z'),
      ev(3, 44, 'resolution_time', 'breach', '2026-07-01T11:00:00Z'),
      ev(4, 45, 'reply_time', 'fulfill', '2026-07-01T12:00:00Z'),
    ];
    expect(countBreaches(events)).toEqual({ reply_time: 2, resolution_time: 1 });
  });
});

describe('summariseDurations', () => {
  it('computes calendar and business stats', () => {
    // One 30-min calendar interval fully inside the Berlin work window → business also 30.
    const pairs = [{ startMs: Date.UTC(2026, 6, 1, 8, 0), endMs: Date.UTC(2026, 6, 1, 8, 30) }]; // 10:00–10:30 Berlin (CEST +2)
    const s = summariseDurations(pairs, BERLIN);
    expect(s.calendar).toEqual({ count: 1, avgMinutes: 30, minMinutes: 30, maxMinutes: 30, p50Minutes: 30 });
    expect(s.business.avgMinutes).toBe(30);
  });
  it('is all-zero for an empty set', () => {
    expect(summariseDurations([], BERLIN).calendar).toEqual({ count: 0, avgMinutes: 0, minMinutes: 0, maxMinutes: 0, p50Minutes: 0 });
  });
});

describe('buildReport + renderReport', () => {
  const rangeStartMs = Date.UTC(2026, 6, 1, 0, 0);
  const rangeEndMs = Date.UTC(2026, 6, 31, 23, 59);
  const report = buildReport({
    tickets: [
      { id: 1, created_at: '2026-07-02T09:00:00Z' },
      { id: 2, created_at: '2026-06-01T09:00:00Z' }, // before range → excluded from volume
    ],
    events: [
      ev(1, 1, 'reply_time', 'activate', '2026-07-02T08:00:00Z'),
      ev(2, 1, 'reply_time', 'fulfill', '2026-07-02T08:20:00Z'),
      ev(3, 1, 'resolution_time', 'activate', '2026-07-02T08:00:00Z'),
      ev(4, 1, 'resolution_time', 'fulfill', '2026-07-02T12:00:00Z'),
      ev(5, 2, 'reply_time', 'breach', '2026-07-03T09:00:00Z'),
    ],
    ratings: [{ score: 'good' }, { score: 'bad' }, { score: 'good' }],
    rangeStartMs,
    rangeEndMs,
    config: BERLIN,
  });

  it('aggregates volume, durations, breaches, CSAT', () => {
    expect(report.volume).toBe(1);
    expect(report.firstReplyTime.calendar.count).toBe(1);
    expect(report.firstReplyTime.calendar.avgMinutes).toBe(20);
    expect(report.resolutionTime.calendar.avgMinutes).toBe(240);
    expect(report.slaBreaches).toEqual({ reply_time: 1 });
    expect(report.slaBreachTotal).toBe(1);
    expect(report.csat).toEqual({ good: 2, bad: 1, rated: 3, scorePct: 67 });
  });

  it('renders a readable summary', () => {
    const text = renderReport(report, 1751328000, 1754006340);
    expect(text).toContain('Ticket volume');
    expect(text).toContain('First reply time — calendar');
    expect(text).toContain('First reply time — business');
    expect(text).toContain('SLA breaches (total 1)');
    expect(text).toContain('CSAT: 67%');
  });
});
