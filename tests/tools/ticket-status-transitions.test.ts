// tests/tools/ticket-status-transitions.test.ts
// #61: the lifecycle table of skills/ticket-manager/SKILL.md:37-44 is enforced, not only
// described. The whole 6×6 table is walked here, both tool paths, through the real McpServer and
// SDK client so the assertion covers the shipped boundary and not just the pure helper.
import { describe, it, expect } from 'vitest';
import { boot, json, once, type Call } from '../skills/probe.js';

const STATUSES = ['new', 'open', 'pending', 'hold', 'solved', 'closed'] as const;
type Status = (typeof STATUSES)[number];
const STAMP = '2026-07-20T10:00:00Z';

// The ❌ cells, read straight off the table: `closed` is terminal, and `new` is never restored.
// `via system` (→ closed) and the diagonal are not ❌ — the table marks neither as refused.
const forbidden = (from: Status, to: Status): boolean => (from === 'closed' && to !== 'closed') || to === 'new';

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
    return n <= 2
      ? json({ job_status: { id: 'job-1' } })
      : json({ job_status: { id: 'job-1', status: 'completed', results: [{ id: 1002, success: true }] } });
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
