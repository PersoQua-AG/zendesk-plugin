// tests/skills/ticket-manager.test.ts
// Deterministic halves of skills/ticket-manager/SKILL.md (S0 rows TM-1..5, TM-10, TM-11).
import { describe, it, expect } from 'vitest';
import { boot, json, once, probeRequests, read, toolsNamedIn, writesIn } from './probe.js';

const STAMP = '2026-07-20T10:00:00Z';
const DESTRUCTIVE = /delete|merge|redact|destroy|spam/i;

describe('ticket-manager: safe update (SKILL.md:26-31)', () => {
  it('TM-1 failcheck: an update with neither updatedStamp nor force is refused before any request', async () => {
    const r = await once('zendesk_update_ticket', { ticketId: 42, fields: { status: 'solved' } });
    expect(r.calls).toEqual([]);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/updatedStamp/);
  });

  it('TM-2 happy: with a stamp the PUT carries safe_update and updated_stamp', async () => {
    const r = await once('zendesk_update_ticket', { ticketId: 42, fields: { status: 'pending' }, updatedStamp: STAMP }, () => json({ ticket: { id: 42 } }));
    expect(r.text).toMatch(/^UPDATED/);
    expect(r.calls.map((c) => c.method)).toEqual(['PUT']);
    const body = JSON.parse(r.calls[0].body ?? '{}');
    expect(body.ticket).toMatchObject({ status: 'pending', safe_update: true, updated_stamp: STAMP });
  });

  // Any follow-up request "succeeds", as a stamp-less re-PUT would in Zendesk: only the METHOD of
  // the second call separates a re-fetch from a blind overwrite (S0 finding 3).
  it('TM-3 failcheck: a stale stamp yields a conflict and no second write', async () => {
    const r = await once('zendesk_update_ticket', { ticketId: 42, fields: { status: 'solved' }, updatedStamp: STAMP }, (_c, n) =>
      n === 1 ? json({ error: 'conflict' }, 409) : json({ ticket: { id: 42, status: 'open', subject: 'Now edited', updated_at: '2026-07-21T00:00:00Z' } }),
    );
    expect(r.text).toMatch(/^CONFLICT/);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['PUT /api/v2/tickets/42.json', 'GET /api/v2/tickets/42.json']);
    expect(r.calls.filter((c) => c.method !== 'GET')).toHaveLength(1);
  });
});

describe('ticket-manager: bulk and tags (SKILL.md:15,78)', () => {
  it('TM-4 failcheck: a bulk update without force:true is refused before any request', async () => {
    const r = await once('zendesk_update_tickets_bulk', { ids: [1, 2], fields: { priority: 'high' } });
    expect(r.calls).toEqual([]);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/force:true/);
  });

  it('TM-5 failcheck: tags append with POST by default and replace with PUT only on replace:true', async () => {
    const b = await boot(() => json({ tags: ['vip'] }));
    await b.call('zendesk_add_ticket_tags', { ticketId: 7, tags: ['vip'] });
    await b.call('zendesk_add_ticket_tags', { ticketId: 7, tags: ['vip'], replace: true });
    await b.close();
    expect(b.calls.map((c) => c.method)).toEqual(['POST', 'PUT']);
  });
});

describe('ticket-manager: never destructive (SKILL.md:82)', () => {
  it('TM-10 failcheck: no registered tool is named, requests a path, or uses a method that is destructive', async () => {
    const requests = await probeRequests();
    const hits = Object.entries(requests).filter(([n, rs]) => DESTRUCTIVE.test(n) || rs.some((r) => r.startsWith('DELETE ') || DESTRUCTIVE.test(r)));
    expect(hits).toEqual([]);
  });
});

describe('ticket-manager: reply drafting is delegated to a read-only agent (SKILL.md:70)', () => {
  it('TM-11 failcheck: every tool on the support-agent allowlist is read-only', async () => {
    const line = read('agents/support-agent.md').match(/^tools:(.*)$/m);
    expect(line, 'agents/support-agent.md has a tools: allowlist').not.toBeNull();
    const tools = toolsNamedIn(line![1]);
    expect(tools.length).toBeGreaterThan(0);
    expect(writesIn(await probeRequests(tools))).toEqual([]);
  });
});
