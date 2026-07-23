// tests/tools/analytics-ticket-metrics.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ticketMetrics } from '../../src/tools/analytics/metrics.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(handle: string): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle, path: '/x' }) } as unknown as ResponseCache;
}

describe('ticketMetrics', () => {
  it('lists via CBP and caches screened metrics', async () => {
    const client = {
      request: vi.fn().mockResolvedValue({
        ticket_metrics: [
          { id: 5, ticket_id: 42, reply_time_in_minutes: { calendar: 30, business: 12 }, full_resolution_time_in_minutes: { calendar: 600, business: 240 } },
        ],
        meta: { has_more: false, after_cursor: null },
        links: { next: null },
      }),
    } as unknown as ZendeskHttpClient;
    const cache = cacheStub('zendesk_ticket_metrics-a1');
    const r = await ticketMetrics(client, cache, {});
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('/ticket_metrics.json');
    const [toolName, cached] = (cache.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(toolName).toBe('zendesk_ticket_metrics');
    expect(cached.ticket_metrics).toHaveLength(1);
    expect(r.summary).toContain('1 ticket metric(s)');
  });

  it('fetches a single ticket metric when ticketId is given', async () => {
    const client = {
      request: vi.fn().mockResolvedValue({ ticket_metric: { id: 7, ticket_id: 42, reply_time_in_minutes: { calendar: 15, business: 15 } } }),
    } as unknown as ZendeskHttpClient;
    const r = await ticketMetrics(client, cacheStub('zendesk_ticket_metrics-b2'), { ticketId: 42 });
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/tickets/42/metrics.json');
    expect(r.summary).toContain('ticket 42');
  });

  it('throws on a malformed single-metric envelope', async () => {
    const client = { request: vi.fn().mockResolvedValue({ nope: true }) } as unknown as ZendeskHttpClient;
    await expect(ticketMetrics(client, cacheStub('x'), { ticketId: 1 })).rejects.toThrow(/Unexpected \/tickets\/\{id\}\/metrics/);
  });
});
