// tests/skills/data-analyst.test.ts
// Deterministic halves of skills/data-analyst/SKILL.md (S0 rows DA-2..DA-5). DA-1 (no percentages)
// is deliberately NOT asserted in either direction: it awaits the owner's decision (S0 finding 1).
import { describe, it, expect } from 'vitest';
import { boot, json, probeMethods, read, toolsNamedIn, writesIn, type Call } from './probe.js';

const SKILL = 'skills/data-analyst/SKILL.md';
const JULY = { startTime: 1782864000, endTime: 1785542400 }; // 2026-07-01 .. 2026-08-01 UTC

// One ticket with one first reply, no resolution events and no CSAT ratings in the window.
function zendesk(c: Call): Response {
  if (c.path.endsWith('/incremental/tickets/cursor.json')) {
    return json({ tickets: [{ id: 1, subject: 'Example subject', created_at: '2026-07-02T09:00:00Z' }], after_cursor: 'c', end_of_stream: true });
  }
  if (c.path.endsWith('/incremental/ticket_metric_events.json')) {
    return json({
      ticket_metric_events: [
        { id: 10, ticket_id: 1, metric: 'reply_time', instance_id: 1, type: 'activate', time: '2026-07-02T10:00:00Z' },
        { id: 11, ticket_id: 1, metric: 'reply_time', instance_id: 1, type: 'fulfill', time: '2026-07-02T10:15:00Z' },
      ],
      end_time: 1785542400, next_page: null, count: 2,
    });
  }
  return json({ satisfaction_ratings: [], meta: { has_more: false, after_cursor: null }, links: { next: null } });
}

async function reportText(args: Record<string, unknown>) {
  const b = await boot(zendesk);
  const r = await b.call('zendesk_report', args);
  await b.close();
  return { ...r, calls: b.calls };
}

describe('data-analyst: composite report (SKILL.md:19-23,29,44)', () => {
  it('DA-2 happy: first-reply and resolution time are each reported twice, labelled calendar and business', async () => {
    const r = await reportText(JULY);
    expect(r.isError).toBe(false);
    for (const metric of ['First reply time', 'Resolution time']) {
      expect(r.text).toMatch(new RegExp(`^${metric} — calendar: avg`, 'm'));
      expect(r.text).toMatch(new RegExp(`^${metric} — business: avg`, 'm'));
    }
  });

  it('DA-3 failcheck: a window that ends before it starts is refused before any request', async () => {
    const r = await reportText({ startTime: JULY.endTime, endTime: JULY.startTime });
    expect(r.calls).toEqual([]);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/end_time .* must be greater than or equal to start_time/);
  });

  it('DA-3 failcheck: a non-positive startTime is rejected by the schema', async () => {
    const r = await reportText({ startTime: 0 });
    expect(r.calls).toEqual([]);
    expect(r.isError).toBe(true);
  });

  it('DA-4 failcheck: a missing CSAT or duration is reported as missing, not as a measured zero', async () => {
    const r = await reportText(JULY);
    expect(r.text).toMatch(/^CSAT: no rated responses$/m);
    expect(r.text).toMatch(/^Resolution time — calendar: .*\(n=0\)$/m);
    expect(r.text).not.toMatch(/null|NaN|undefined/);
  });
});

describe('data-analyst: read-only (SKILL.md:8)', () => {
  it('DA-5 failcheck: every tool the skill names issues only GET requests', async () => {
    const tools = toolsNamedIn(read(SKILL));
    expect(tools).toContain('zendesk_report');
    expect(writesIn(await probeMethods(tools))).toEqual([]);
  });
});
