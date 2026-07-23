// tests/tools/analytics-business-hours.test.ts
import { describe, it, expect } from 'vitest';
import {
  businessMinutesBetween,
  calendarMinutesBetween,
  zonedTimeToUtc,
  parseReportConfig,
  DEFAULT_BUSINESS_HOURS,
  type BusinessHoursConfig,
} from '../../src/tools/analytics/business-hours.js';

const BERLIN: BusinessHoursConfig = {
  timeZone: 'Europe/Berlin',
  workHours: { start: '09:00', end: '17:00' },
  workdays: [1, 2, 3, 4, 5],
};

// Berlin wall-clock → UTC epoch ms, for readable fixtures.
const at = (y: number, m: number, d: number, h: number, min: number) => zonedTimeToUtc('Europe/Berlin', y, m, d, h, min);

describe('zonedTimeToUtc (DST-aware)', () => {
  it('applies the +01:00 offset before the spring-forward (2026-03-28)', () => {
    expect(zonedTimeToUtc('Europe/Berlin', 2026, 3, 28, 12, 0)).toBe(Date.UTC(2026, 2, 28, 11, 0));
  });
  it('applies the +02:00 offset after the spring-forward (2026-03-30)', () => {
    expect(zonedTimeToUtc('Europe/Berlin', 2026, 3, 30, 12, 0)).toBe(Date.UTC(2026, 2, 30, 10, 0));
  });
  it('applies +02:00 before the fall-back (2026-10-24)', () => {
    expect(zonedTimeToUtc('Europe/Berlin', 2026, 10, 24, 12, 0)).toBe(Date.UTC(2026, 9, 24, 10, 0));
  });
  it('applies +01:00 after the fall-back (2026-10-26)', () => {
    expect(zonedTimeToUtc('Europe/Berlin', 2026, 10, 26, 12, 0)).toBe(Date.UTC(2026, 9, 26, 11, 0));
  });
});

describe('businessMinutesBetween', () => {
  it('same-day partial window', () => {
    // Tue 2026-03-10, 10:00 → 12:30 = 150 min, fully inside 09–17.
    expect(businessMinutesBetween(at(2026, 3, 10, 10, 0), at(2026, 3, 10, 12, 30), BERLIN)).toBe(150);
  });

  it('clamps to the work window (08:00 → 18:00 counts only 09–17 = 480)', () => {
    expect(businessMinutesBetween(at(2026, 3, 10, 8, 0), at(2026, 3, 10, 18, 0), BERLIN)).toBe(480);
  });

  it('returns 0 across a full weekend day (Sat)', () => {
    // Sat 2026-03-14 10:00 → 14:00.
    expect(businessMinutesBetween(at(2026, 3, 14, 10, 0), at(2026, 3, 14, 14, 0), BERLIN)).toBe(0);
  });

  it('weekend spillover: Fri 16:00 → Mon 10:00 = 60 + 60 = 120', () => {
    // Fri 2026-03-13 16:00 → Mon 2026-03-16 10:00. Fri 16–17 = 60, Sat/Sun 0, Mon 09–10 = 60.
    expect(businessMinutesBetween(at(2026, 3, 13, 16, 0), at(2026, 3, 16, 10, 0), BERLIN)).toBe(120);
  });

  it('multi-week: Mon 09:00 → next Mon 09:00 = 5 workdays × 480 = 2400', () => {
    expect(businessMinutesBetween(at(2026, 3, 9, 9, 0), at(2026, 3, 16, 9, 0), BERLIN)).toBe(2400);
  });

  it('spans the spring-forward weekend: Fri 09:00 → Mon 17:00 = 480 + 480 = 960', () => {
    // Fri 2026-03-27 → Mon 2026-03-30; DST starts Sun 2026-03-29 (a skipped weekend day).
    expect(businessMinutesBetween(at(2026, 3, 27, 9, 0), at(2026, 3, 30, 17, 0), BERLIN)).toBe(960);
  });

  it('spans the fall-back weekend: Fri 09:00 → Mon 17:00 = 960', () => {
    // Fri 2026-10-23 → Mon 2026-10-26; DST ends Sun 2026-10-25 (skipped weekend day).
    expect(businessMinutesBetween(at(2026, 10, 23, 9, 0), at(2026, 10, 26, 17, 0), BERLIN)).toBe(960);
  });

  it('returns 0 for a zero or negative interval', () => {
    expect(businessMinutesBetween(at(2026, 3, 10, 12, 0), at(2026, 3, 10, 12, 0), BERLIN)).toBe(0);
    expect(businessMinutesBetween(at(2026, 3, 10, 12, 0), at(2026, 3, 10, 9, 0), BERLIN)).toBe(0);
  });

  it('start after close contributes nothing that day', () => {
    // Tue 18:00 → Wed 10:00: Tue 0 (after close), Wed 09–10 = 60.
    expect(businessMinutesBetween(at(2026, 3, 10, 18, 0), at(2026, 3, 11, 10, 0), BERLIN)).toBe(60);
  });

  it('rejects an inverted work window', () => {
    const bad: BusinessHoursConfig = { timeZone: 'UTC', workHours: { start: '17:00', end: '09:00' }, workdays: [1] };
    expect(() => businessMinutesBetween(0, 60_000, bad)).toThrow(/end must be after start/i);
  });
});

describe('calendarMinutesBetween', () => {
  it('is the raw wall-clock delta in minutes', () => {
    // 4740 min from Fri 08:00 UTC to Mon 15:00 UTC (see business test above).
    expect(calendarMinutesBetween(at(2026, 3, 27, 9, 0), at(2026, 3, 30, 17, 0))).toBe(4740);
  });
  it('returns 0 for a non-positive interval', () => {
    expect(calendarMinutesBetween(100, 100)).toBe(0);
    expect(calendarMinutesBetween(200, 100)).toBe(0);
  });
});

describe('parseReportConfig', () => {
  it('defaults to UTC / 09:00–17:00 / Mon–Fri when env is empty', () => {
    expect(parseReportConfig({})).toEqual(DEFAULT_BUSINESS_HOURS);
  });
  it('reads timezone, work_hours JSON, and workdays JSON from env', () => {
    const cfg = parseReportConfig({
      ZENDESK_TIMEZONE: 'Europe/Berlin',
      ZENDESK_WORK_HOURS: '{"start":"08:30","end":"16:30"}',
      ZENDESK_WORKDAYS: '[1,2,3,4]',
    });
    expect(cfg).toEqual({ timeZone: 'Europe/Berlin', workHours: { start: '08:30', end: '16:30' }, workdays: [1, 2, 3, 4] });
  });
  it('falls back to defaults on malformed JSON rather than throwing', () => {
    expect(parseReportConfig({ ZENDESK_WORK_HOURS: 'not json', ZENDESK_WORKDAYS: '{oops' })).toEqual(DEFAULT_BUSINESS_HOURS);
  });
});
