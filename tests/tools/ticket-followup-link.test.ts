// tests/tools/ticket-followup-link.test.ts
// #66: a follow-up ticket must actually carry via_followup_source_id to the closed source ticket.
// These go through the REAL McpServer + SDK client, because the defect was a zod object silently
// stripping the undeclared key — calling the src/tools/* function directly would bypass that parse
// and pass for the wrong reason.
import { describe, it, expect } from 'vitest';
import { jobReply, json, once, type Call } from '../skills/probe.js';

const SOURCE = 123;
const COMMENT = { body: 'Picking this up again', public: true };

// create_many is an async job: hand back a job id, then a completed status on the poll.
const bulkReply = (_c: Call, n: number): Response => jobReply(n, [{ id: 9001, success: true }]);

const singleReply = (): Response => json({ ticket: { id: 9001 } });

const bodyOf = (calls: Call[], path: string): Record<string, never> =>
  JSON.parse(calls.find((c) => c.path.endsWith(path))?.body ?? '{}');

describe('follow-up tickets keep their link to the closed source ticket (#66)', () => {
  it('bulk: via_followup_source_id reaches the create_many body', async () => {
    const r = await once(
      'zendesk_create_tickets_bulk',
      { tickets: [{ subject: 'Follow-up: Printer down', comment: COMMENT, requester_id: 7, via_followup_source_id: SOURCE }] },
      bulkReply,
    );
    expect(r.isError).toBe(false);
    const body = bodyOf(r.calls, '/tickets/create_many.json') as unknown as { tickets: Record<string, unknown>[] };
    expect(body.tickets[0].via_followup_source_id).toBe(SOURCE);
    // requester_id is the control: a declared field that always reached the body.
    expect(body.tickets[0].requester_id).toBe(7);
  });

  it('single: followupSourceId is mapped to via_followup_source_id in the /tickets.json body', async () => {
    const r = await once(
      'zendesk_create_ticket',
      { subject: 'Follow-up: Printer down', comment: 'Picking this up again', requesterId: 7, followupSourceId: SOURCE },
      singleReply,
    );
    expect(r.isError).toBe(false);
    const body = bodyOf(r.calls, '/tickets.json') as unknown as { ticket: Record<string, unknown> };
    expect(body.ticket.via_followup_source_id).toBe(SOURCE);
    expect(body.ticket.requester_id).toBe(7);
  });

  it.each([0, -1, 1.5, '123'])('bulk: a malformed source id (%p) is refused before any request', async (bad) => {
    const r = await once(
      'zendesk_create_tickets_bulk',
      { tickets: [{ subject: 'Follow-up', comment: COMMENT, via_followup_source_id: bad }] },
      bulkReply,
    );
    expect(r.isError).toBe(true);
    expect(r.calls).toEqual([]);
  });

  it.each([0, -1, 1.5, '123'])('single: a malformed source id (%p) is refused before any request', async (bad) => {
    const r = await once('zendesk_create_ticket', { subject: 'Follow-up', comment: 'hi', followupSourceId: bad }, singleReply);
    expect(r.isError).toBe(true);
    expect(r.calls).toEqual([]);
  });

  it('no link requested: the key is absent from both bodies, not merely undefined', async () => {
    const bulk = await once('zendesk_create_tickets_bulk', { tickets: [{ subject: 'Plain', comment: COMMENT }] }, bulkReply);
    const bulkRecord = (bodyOf(bulk.calls, '/tickets/create_many.json') as unknown as { tickets: object[] }).tickets[0];
    expect(Object.keys(bulkRecord)).not.toContain('via_followup_source_id');

    const single = await once('zendesk_create_ticket', { subject: 'Plain', comment: 'hi' }, singleReply);
    const ticket = (bodyOf(single.calls, '/tickets.json') as unknown as { ticket: object }).ticket;
    expect(Object.keys(ticket)).not.toContain('via_followup_source_id');
  });
});
