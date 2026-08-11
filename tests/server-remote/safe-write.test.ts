import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { startRemote, zendeskMock, type RemoteHarness } from './harness.js';

let h: RemoteHarness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const NO_DESTRUCTIVE = /delete|merge|redact|destroy|spam/i;

describe('safe write over the remote transport (REQ-6)', () => {
  it('applies a funding-status custom_field update with safe_update optimistic concurrency', async () => {
    let putBody: { ticket?: Record<string, unknown> } = {};
    const fetchImpl = zendeskMock({
      'PUT /api/v2/tickets/42.json': (_url, init) => {
        putBody = JSON.parse(String(init.body));
        return ok({ ticket: { id: 42, custom_fields: [{ id: 900, value: 'Bewilligt' }] } });
      },
    });
    h = await startRemote(fetchImpl);

    const text = await h.callText('zendesk_update_ticket', {
      ticketId: 42,
      fields: { custom_fields: [{ id: 900, value: 'Bewilligt' }] },
      updatedStamp: '2026-07-20T10:00:00Z',
    });

    expect(text).toContain('UPDATED');
    expect(putBody.ticket?.safe_update).toBe(true);
    expect(putBody.ticket?.updated_stamp).toBe('2026-07-20T10:00:00Z');
    // Audited with the hashed identity, applied outcome.
    const audit = JSON.parse(readFileSync(h.auditPath, 'utf8').trim());
    expect(audit).toMatchObject({ tool: 'zendesk_update_ticket', targetId: '42', outcome: 'applied' });
    expect(readFileSync(h.auditPath, 'utf8')).not.toContain('zendesk:1');
  });

  it('on 409 re-fetches and returns a conflict result (no blind overwrite)', async () => {
    const fetchImpl = zendeskMock({
      'PUT /api/v2/tickets/42.json': () => new Response('conflict', { status: 409 }),
      'GET /api/v2/tickets/42.json': () =>
        ok({ ticket: { id: 42, subject: 'Now edited', status: 'open', updated_at: '2026-07-21T00:00:00Z' } }),
    });
    h = await startRemote(fetchImpl);

    const text = await h.callText('zendesk_update_ticket', {
      ticketId: 42,
      fields: { custom_fields: [{ id: 900, value: 'Bewilligt' }] },
      updatedStamp: '2026-07-20T10:00:00Z',
    });
    expect(text).toContain('CONFLICT');
    const audit = JSON.parse(readFileSync(h.auditPath, 'utf8').trim());
    expect(audit).toMatchObject({ tool: 'zendesk_update_ticket', targetId: '42', outcome: 'conflict' });
  });

  it('exposes no destructive ticket tool (enforced by omission)', async () => {
    h = await startRemote(zendeskMock({}));
    const names = await h.toolNames();
    expect(names.filter((n) => NO_DESTRUCTIVE.test(n))).toEqual([]);
  });
});
