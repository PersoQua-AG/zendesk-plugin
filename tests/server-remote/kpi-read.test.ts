import { describe, it, expect, afterEach } from 'vitest';
import { startRemote, zendeskMock, type RemoteHarness } from './harness.js';

let h: RemoteHarness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('KPI read path over the remote transport (REQ-5)', () => {
  it('counts funding tickets via zendesk_search with no write tool invoked', async () => {
    let writes = 0;
    const fetchImpl = zendeskMock({
      'GET /api/v2/search.json': () =>
        ok({
          results: [
            { id: 1, subject: 'A', custom_fields: [{ id: 900, value: 'Bewilligt' }] },
            { id: 2, subject: 'B', custom_fields: [{ id: 900, value: 'Abgelehnt' }] },
          ],
          count: 2,
          next_page: null,
        }),
      'PUT /api/v2/tickets/1.json': () => {
        writes++;
        return ok({ ticket: { id: 1 } });
      },
    });
    h = await startRemote(fetchImpl);

    const text = await h.callText('zendesk_search', { query: 'fielddata', type: 'ticket' });
    expect(text).toContain('2 result(s)');
    expect(writes).toBe(0);
  });

  it('returns an explicit zero (not an error) for an empty range', async () => {
    const fetchImpl = zendeskMock({
      'GET /api/v2/search.json': () => ok({ results: [], count: 0, next_page: null }),
    });
    h = await startRemote(fetchImpl);

    const text = await h.callText('zendesk_search', { query: 'created>2099-01-01', type: 'ticket' });
    expect(text).toContain('0 result(s)');
  });
});
