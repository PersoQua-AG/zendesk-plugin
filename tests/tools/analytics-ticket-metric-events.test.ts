// tests/tools/analytics-ticket-metric-events.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ticketMetricEvents } from '../../src/tools/analytics/incremental.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_ticket_metric_events-a1', path: '/x' }) } as unknown as ResponseCache;
}

describe('ticketMetricEvents', () => {
  it('pages time-mode via the incremental rate class until count < 1000', async () => {
    const client = {
      request: vi.fn().mockResolvedValue({
        ticket_metric_events: [
          { id: 100, ticket_id: 42, metric: 'reply_time', instance_id: 1, type: 'activate', time: '2026-07-01T09:00:00Z' },
          { id: 101, ticket_id: 42, metric: 'reply_time', instance_id: 1, type: 'fulfill', time: '2026-07-01T09:30:00Z' },
        ],
        end_time: 1719_500_000, next_page: null, count: 2,
      }),
    } as unknown as ZendeskHttpClient;
    const cache = cacheStub();
    const r = await ticketMetricEvents(client, cache, { startTime: 1719_000_000 });
    const calls = (client.request as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain('/incremental/ticket_metric_events.json?start_time=1719000000');
    expect(calls[0][2]).toEqual({ rateClass: 'incremental' });
    const [, cached] = (cache.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cached.ticket_metric_events).toHaveLength(2);
    expect(r.summary).toContain('2 metric event(s)');
  });

  it('rejects a non-positive start_time', async () => {
    const client = { request: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(ticketMetricEvents(client, cacheStub(), { startTime: 0 })).rejects.toThrow(/start_time/i);
  });

  it('throws on a malformed time envelope', async () => {
    const client = { request: vi.fn().mockResolvedValue({ nope: true }) } as unknown as ZendeskHttpClient;
    await expect(ticketMetricEvents(client, cacheStub(), { startTime: 1 })).rejects.toThrow(/Unexpected \/incremental\/ticket_metric_events/);
  });
});
