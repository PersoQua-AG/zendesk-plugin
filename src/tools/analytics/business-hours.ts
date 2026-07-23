// src/tools/analytics/business-hours.ts
// Pure, dependency-free business-hours duration math for zendesk_report. Calendar minutes are the
// raw wall-clock delta; business minutes count only time inside the configured work window on
// worked weekdays, in the configured IANA timezone, DST-aware. See the DST limitation flagged in
// the M6 plan Dependencies: the work window is assumed to sit outside the transition instant
// (default 09:00–17:00 never overlaps a 02:00–03:00 transition).

export interface WorkHours {
  start: string; // 'HH:MM' 24h local wall time, e.g. '09:00'
  end: string;   // 'HH:MM' 24h local wall time, e.g. '17:00' (must be after start)
}

export interface BusinessHoursConfig {
  timeZone: string;    // IANA zone, e.g. 'Europe/Berlin'
  workHours: WorkHours;
  workdays: number[];  // worked ISO weekdays: 1=Mon … 7=Sun
}

export const DEFAULT_BUSINESS_HOURS: BusinessHoursConfig = {
  timeZone: 'UTC',
  workHours: { start: '09:00', end: '17:00' },
  workdays: [1, 2, 3, 4, 5],
};

// Guard the day loop even against absurd inputs (~21 years of days).
const MAX_DAYS = 8000;

const WEEKDAY_INDEX: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

interface LocalDate {
  year: number;
  month: number; // 1–12
  day: number;
  weekday: number; // ISO 1=Mon … 7=Sun
}

// The zone's offset from UTC (ms, positive = ahead) at a given instant, by formatting the instant
// as wall-clock parts in the zone and diffing from a UTC-interpreted rebuild of those parts.
function tzOffsetMs(timeZone: string, epochMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(epochMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - epochMs;
}

// Wall-clock local date (+ ISO weekday) of an instant in the target zone.
export function localDate(timeZone: string, epochMs: number): LocalDate {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  });
  const parts = dtf.formatToParts(new Date(epochMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAY_INDEX[get('weekday')],
  };
}

// The UTC instant of a wall-clock time in the target zone. Two-pass: an offset can itself shift
// across the candidate wall time on a DST boundary, so re-apply the offset measured AT the
// candidate instant. Correct for all realistic (non-boundary-straddling) work windows.
export function zonedTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const offset1 = tzOffsetMs(timeZone, utcGuess);
  let epoch = utcGuess - offset1;
  const offset2 = tzOffsetMs(timeZone, epoch);
  if (offset2 !== offset1) epoch = utcGuess - offset2;
  return epoch;
}

// Next calendar day, in plain Y/M/D, using a UTC Date purely for month/year rollover arithmetic
// (no zone involved — these are abstract calendar numbers fed back to zonedTimeToUtc).
function nextDay(d: LocalDate): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(d.year, d.month - 1, d.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function parseHm(hm: string): { hour: number; minute: number } {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hm);
  if (!m) throw new Error(`Invalid work-hours time "${hm}" — expected 24h "HH:MM".`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function calendarMinutesBetween(startMs: number, endMs: number): number {
  if (endMs <= startMs) return 0;
  return Math.round((endMs - startMs) / 60_000);
}

// Business minutes between two instants: sum the overlap of [start,end] with each worked day's
// work window, in the configured zone. Returns 0 for a non-positive interval.
export function businessMinutesBetween(startMs: number, endMs: number, config: BusinessHoursConfig): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error('businessMinutesBetween: non-finite timestamp.');
  }
  if (endMs <= startMs) return 0;
  const open = parseHm(config.workHours.start);
  const close = parseHm(config.workHours.end);
  if (close.hour * 60 + close.minute <= open.hour * 60 + open.minute) {
    throw new Error('businessMinutesBetween: work_hours end must be after start (overnight windows unsupported).');
  }
  const workdays = new Set(config.workdays);
  let totalMs = 0;
  let cursor: { year: number; month: number; day: number } = localDate(config.timeZone, startMs);
  for (let guard = 0; guard < MAX_DAYS; guard++) {
    const dayOpen = zonedTimeToUtc(config.timeZone, cursor.year, cursor.month, cursor.day, open.hour, open.minute);
    if (dayOpen > endMs) break; // past the interval
    const iso = localDate(config.timeZone, dayOpen).weekday;
    if (workdays.has(iso)) {
      const dayClose = zonedTimeToUtc(config.timeZone, cursor.year, cursor.month, cursor.day, close.hour, close.minute);
      const from = Math.max(startMs, dayOpen);
      const to = Math.min(endMs, dayClose);
      if (to > from) totalMs += to - from;
    }
    cursor = nextDay({ ...cursor, weekday: iso });
  }
  return Math.round(totalMs / 60_000);
}

// Parse the business-hours config from environment (PRD §8). Malformed JSON degrades to defaults
// rather than crashing server boot — the report still runs, just on the default window.
export function parseReportConfig(env: Record<string, string | undefined>): BusinessHoursConfig {
  const timeZone = env.ZENDESK_TIMEZONE?.trim() || DEFAULT_BUSINESS_HOURS.timeZone;
  const workHours = parseWorkHours(env.ZENDESK_WORK_HOURS);
  const workdays = parseWorkdays(env.ZENDESK_WORKDAYS);
  return { timeZone, workHours, workdays };
}

function parseWorkHours(raw: string | undefined): WorkHours {
  if (!raw) return DEFAULT_BUSINESS_HOURS.workHours;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      const { start, end } = parsed as Record<string, unknown>;
      if (typeof start === 'string' && typeof end === 'string') {
        parseHm(start);
        parseHm(end);
        return { start, end };
      }
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_BUSINESS_HOURS.workHours;
}

function parseWorkdays(raw: string | undefined): number[] {
  if (!raw) return DEFAULT_BUSINESS_HOURS.workdays;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const days = parsed.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 7);
      if (days.length > 0) return days;
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_BUSINESS_HOURS.workdays;
}
