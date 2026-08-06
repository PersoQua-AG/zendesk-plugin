import { describe, it, expect, afterEach } from 'vitest';
import { startRemote, zendeskMock, type RemoteHarness } from './harness.js';

// REQ-11: in-process MCP client boots over the HTTP transport and calls a tool end-to-end against
// a mocked Zendesk (no live network) — the remote release-gate smoke.
let h: RemoteHarness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

describe('remote release-gate smoke', () => {
  it('initializes over HTTP, lists 64 tools, and calls a read tool without throwing', async () => {
    const fetchImpl = zendeskMock({
      'GET /api/v2/tickets/7.json': () =>
        new Response(JSON.stringify({ ticket: { id: 7, subject: 'Förderantrag', updated_at: '2026-07-20T10:00:00Z' } }), { status: 200 }),
    });
    h = await startRemote(fetchImpl);

    expect(await h.toolNames()).toHaveLength(64);
    const text = await h.callText('zendesk_get_ticket', { ticketId: 7 });
    expect(text).toContain('updated_stamp');
  });
});
