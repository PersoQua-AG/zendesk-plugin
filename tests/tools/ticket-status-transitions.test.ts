// tests/tools/ticket-status-transitions.test.ts
// #61: the lifecycle table of skills/ticket-manager/SKILL.md:37-44 is enforced, not only
// described. The whole 6×6 table is walked here, both tool paths, through the real McpServer and
// SDK client so the assertion covers the shipped boundary and not just the pure helper.
import { describe, it, expect } from 'vitest';
import { boot, jobReply, json, once, read, type Call } from '../skills/probe.js';

const STATUSES = ['new', 'open', 'pending', 'hold', 'solved', 'closed'] as const;
type Status = (typeof STATUSES)[number];
const STAMP = '2026-07-20T10:00:00Z';

const SKILL = read('skills/ticket-manager/SKILL.md');

// The expectation is TRANSCRIBED from the document, never retyped from the production rule: a test
// that restates `transitionRefusal` agrees with it by construction and cannot notice a wrong rule.
//
// The table is read WHOLE — header row for the column order, body rows for the row order, both
// checked against STATUSES. Taking the column order from a hardcoded list instead was measured to
// leave all cases green while the document published `open → new ✅`, and reading only the rows we
// already knew about left a seventh status added to the table silently untested.
const CELLS = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

const TABLE_BLOCK = (SKILL.match(/^\| *From *\\ *To *\|.*(?:\n\|.*)*/m) ?? [''])[0].split('\n');
const HEADER = CELLS(TABLE_BLOCK[0] ?? '').slice(1);
const ROWS = new Map(
  TABLE_BLOCK.slice(2).map((line) => {
    const cells = CELLS(line);
    return [cells[0].replaceAll('*', '').trim(), cells.slice(1)] as const;
  }),
);

// The diagonal cell is `—` for every status, which on its own says "same status, not a transition".
// For two of them the Rules prose beneath the table overrides that and refuses it outright, and the
// owner confirmed both on 2026-10-07. The sentences are asserted below, so this list cannot drift
// from the document either.
const TERMINAL_SELF: readonly string[] = ['new', 'closed'];

// ❌ refuses. ✅ (with or without a parenthetical) and `via system` allow. `—` is the diagonal and
// refuses only where a Rules line says the status takes no self-transition.
function forbidden(from: Status, to: Status): boolean {
  const cell = ROWS.get(from)?.[HEADER.indexOf(to)];
  if (cell === undefined) throw new Error(`SKILL.md publishes no cell for ${from} → ${to}`);
  if (cell.startsWith('❌')) return true;
  if (cell.startsWith('✅') || cell === 'via system') return false;
  if (cell === '—') return TERMINAL_SELF.includes(to);
  throw new Error(`unreadable cell '${cell}' at ${from} → ${to}`);
}

describe('the transcribed table is the one the skill publishes', () => {
  // Both axes, in order. Either assertion failing means the grid below is reading other cells than
  // the ones the document shows, which is the one way a transcription can lie.
  it('publishes exactly these columns, in this order', () => {
    expect(HEADER).toEqual([...STATUSES]);
  });

  it('publishes exactly these rows, in this order', () => {
    expect([...ROWS.keys()]).toEqual([...STATUSES]);
  });

  // The two Rules lines that make the diagonal refuse, quoted from the document they come from.
  it('carries the prose that refuses new → new and closed → closed', () => {
    expect(SKILL).toContain('A closed ticket cannot be reopened or edited.');
    expect(SKILL).toContain('The tool refuses it from every state');
  });
});

// Answers the pre-read with `current`, every other request with a plain success echo.
const replyWithStatus = (current: Status, ticketId = 1001) => (c: Call): Response =>
  c.method === 'GET' && c.path.endsWith(`/tickets/${ticketId}.json`)
    ? json({ ticket: { id: ticketId, status: current } })
    : json({ ticket: { id: ticketId } });

const cases = STATUSES.flatMap((from) => STATUSES.map((to) => ({ from, to })));

describe('zendesk_update_ticket enforces the lifecycle table (#61)', () => {
  it.each(cases)('$from → $to', async ({ from, to }) => {
    const r = await once('zendesk_update_ticket', { ticketId: 1001, fields: { status: to }, updatedStamp: STAMP }, replyWithStatus(from));
    const puts = r.calls.filter((c) => c.method === 'PUT');
    if (forbidden(from, to)) {
      expect(r.isError).toBe(true);
      expect(puts).toEqual([]);
      expect(r.text).toMatch(/Refusing/); // the result names the refused transition and why
      expect(r.text).toContain(to);
    } else {
      expect(r.isError).toBe(false);
      expect(puts).toHaveLength(1);
      expect(JSON.parse(puts[0].body ?? '{}').ticket.status).toBe(to);
    }
  });

  it('force:true does not buy a forbidden transition — force overrides concurrency, not the table', async () => {
    const r = await once('zendesk_update_ticket', { ticketId: 1001, fields: { status: 'open' }, force: true }, replyWithStatus('closed'));
    expect(r.isError).toBe(true);
    expect(r.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(r.text).toMatch(/terminal/);
    expect(r.text).toMatch(/followupSourceId|via_followup_source_id/); // suggests the linked follow-up
  });

  it('→ new is refused without reading the ticket at all', async () => {
    const r = await once('zendesk_update_ticket', { ticketId: 1001, fields: { status: 'new' }, updatedStamp: STAMP }, replyWithStatus('open'));
    expect(r.isError).toBe(true);
    expect(r.calls).toEqual([]);
  });

  it('an update that changes no status is not gated and reads nothing extra', async () => {
    const r = await once('zendesk_update_ticket', { ticketId: 1001, fields: { priority: 'high' }, updatedStamp: STAMP }, replyWithStatus('closed'));
    expect(r.isError).toBe(false);
    expect(r.calls.map((c) => c.method)).toEqual(['PUT']);
  });
});

describe('zendesk_update_tickets_bulk enforces the lifecycle table (#61)', () => {
  // show_many answers both ids; the closed one must be dropped from the update_many id list.
  const bulkReply = (c: Call, n: number): Response => {
    if (c.path.endsWith('/tickets/show_many.json')) {
      return json({ tickets: [{ id: 1001, status: 'closed' }, { id: 1002, status: 'open' }] });
    }
    return jobReply(n, [{ id: 1002, success: true }], 2);
  };

  // The id LIST that reaches update_many is asserted in tests/tools/ticket-bulk-update.test.ts,
  // where the request path is visible with its query string. Here: the batch still runs, and the
  // refused ticket is named back to the model rather than silently dropped.
  it('still writes the batch and names the refused ticket in the result', async () => {
    const r = await once('zendesk_update_tickets_bulk', { ids: [1001, 1002], fields: { status: 'pending' }, force: true }, bulkReply);
    expect(r.isError).toBe(false);
    expect(r.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(r.text).toMatch(/not written: 1001/);
  });

  it('a batch in which no ticket may move is refused before any write', async () => {
    const b = await boot((c) =>
      c.path.endsWith('/tickets/show_many.json') ? json({ tickets: [{ id: 1001, status: 'closed' }] }) : json({}),
    );
    const r = await b.call('zendesk_update_tickets_bulk', { ids: [1001], fields: { status: 'open' }, force: true });
    await b.close();
    expect(r.isError).toBe(true);
    expect(b.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('→ new is refused for the whole batch without reading anything', async () => {
    const r = await once('zendesk_update_tickets_bulk', { ids: [1001, 1002], fields: { status: 'new' }, force: true }, bulkReply);
    expect(r.isError).toBe(true);
    expect(r.calls).toEqual([]);
  });
});

// #61, QA round 1: the guard used to be fail-OPEN. A status it could not read counted as "not
// closed" and the write went through, which is the one case the guard exists for — a closed ticket
// edited unnoticed. Both tool paths now refuse, and show_many is parsed per record so one malformed
// ticket cannot blank the whole batch into "unknown".
describe('an unreadable current status refuses the write (#61, fail-closed)', () => {
  it('refuses the single update when the pre-read carries no status', async () => {
    const r = await once(
      'zendesk_update_ticket',
      { ticketId: 1001, fields: { status: 'open' }, updatedStamp: STAMP },
      (c: Call): Response => json(c.method === 'GET' ? { ticket: { id: 1001 } } : {}),
    );
    expect(r.isError).toBe(true);
    expect(r.calls.filter((c) => c.method === 'PUT')).toEqual([]);
    expect(r.text).toMatch(/could not be read/);
  });

  it('refuses the single update when the pre-read does not parse at all', async () => {
    const r = await once(
      'zendesk_update_ticket',
      { ticketId: 1001, fields: { status: 'open' }, updatedStamp: STAMP },
      (c: Call): Response => json(c.method === 'GET' ? { nonsense: true } : {}),
    );
    expect(r.isError).toBe(true);
    expect(r.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('drops a bulk id show_many did not answer for, instead of writing it', async () => {
    const r = await once(
      'zendesk_update_tickets_bulk',
      { ids: [1001, 1002], fields: { status: 'pending' }, force: true },
      (c: Call, n: number): Response => {
        if (c.path.includes('/tickets/show_many.json')) return json({ tickets: [{ id: 1002, status: 'open' }] });
        return jobReply(n, [{ id: 1002, success: true }], 2);
      },
    );
    expect(r.isError).toBe(false);
    // The REASON matters: an id show_many did not answer for may be a deleted ticket, and calling
    // that a forbidden transition sends the model to the linked-follow-up remedy for a ticket that
    // does not exist. The two causes are reported apart.
    expect(r.text).toMatch(/Current status could not be read[^.]*1001/);
    expect(r.text).not.toMatch(/forbidden status transition/);
  });

  // Per RECORD, not per response: 1001 is malformed, 1002 is fine and must still be written.
  it('keeps the readable records when one record in show_many is malformed', async () => {
    const r = await once(
      'zendesk_update_tickets_bulk',
      { ids: [1001, 1002], fields: { status: 'pending' }, force: true },
      (c: Call, n: number): Response => {
        if (c.path.includes('/tickets/show_many.json')) {
          return json({ tickets: [{ id: 'not-a-number', status: 'open' }, { id: 1002, status: 'open' }] });
        }
        return jobReply(n, [{ id: 1002, success: true }], 2);
      },
    );
    expect(r.isError).toBe(false);
    expect(r.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(r.text).toMatch(/Current status could not be read[^.]*1001/);
    expect(r.text).not.toMatch(/1002/);
  });
});
