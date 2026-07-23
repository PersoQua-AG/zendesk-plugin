// tests/tools/analytics-report-tool.test.ts
import { describe, it, expect, vi } from 'vitest';
import { report } from '../../src/tools/analytics/report.js';
import { DEFAULT_BUSINESS_HOURS } from '../../src/tools/analytics/business-hours.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';
import type { ResponseCache } from '../../src/client/cache.js';

function cacheStub(): ResponseCache {
  return { save: vi.fn().mockReturnValue({ handle: 'zendesk_report-a1', path: '/x' }) } as unknown as ResponseCache;
}

// Route each endpoint to its fixture by path.
function routedClient(): ZendeskHttpClient {
  return {
    request: vi.fn((path: string) => {
      if (path.startsWith('/incremental/tickets/cursor.json')) {
        return Promise.resolve({ tickets: [{ id: 1, subject: 'A', created_at: '2026-07-02T09:00:00Z' }], after_cursor: 'c', end_of_stream: true });
      }
      if (path.startsWith('/incremental/ticket_metric_events.json')) {
        return Promise.resolve({
          ticket_metric_events: [
            // 10:00–10:15 UTC sits inside the default UTC 09:00–17:00 work window, so
            // business minutes == calendar minutes == 15 (fixture corrected from the plan's
            // 08:00–08:15, which is before the UTC window opens and would yield business 0).
            { id: 10, ticket_id: 1, metric: 'reply_time', instance_id: 1, type: 'activate', time: '2026-07-02T10:00:00Z' },
            { id: 11, ticket_id: 1, metric: 'reply_time', instance_id: 1, type: 'fulfill', time: '2026-07-02T10:15:00Z' },
            { id: 12, ticket_id: 1, metric: 'resolution_time', instance_id: 1, type: 'breach', time: '2026-07-02T09:00:00Z' },
          ],
          end_time: 1751500000, next_page: null, count: 3,
        });
      }
      if (path.startsWith('/satisfaction_ratings.json')) {
        return Promise.resolve({ satisfaction_ratings: [{ id: 5, score: 'good', comment: 'thanks' }], meta: { has_more: false, after_cursor: null }, links: { next: null } });
      }
      throw new Error(`unexpected path ${path}`);
    }),
  } as unknown as ZendeskHttpClient;
}

describe('report (composite)', () => {
  const startTime = Math.floor(Date.UTC(2026, 6, 1, 0, 0) / 1000);
  const endTime = Math.floor(Date.UTC(2026, 6, 31, 23, 59) / 1000);

  it('aggregates across incremental + metric events + ratings and caches raw pulls + report', async () => {
    const client = routedClient();
    const cache = cacheStub();
    const r = await report(client, cache, { startTime, endTime }, DEFAULT_BUSINESS_HOURS, 'standard');

    // incremental endpoints use the 10/min bucket.
    const calls = (client.request as ReturnType<typeof vi.fn>).mock.calls;
    const incCalls = calls.filter((c) => String(c[0]).startsWith('/incremental/'));
    expect(incCalls.every((c) => c[2] && (c[2] as { rateClass?: string }).rateClass === 'incremental')).toBe(true);

    expect(r.summary).toContain('Ticket volume (created in range): 1');
    expect(r.summary).toContain('First reply time — calendar: avg 15m');
    expect(r.summary).toContain('First reply time — business: avg 15m');
    expect(r.summary).toContain('SLA breaches (total 1)');
    expect(r.summary).toContain('CSAT: 100%');

    const [toolName, cached] = (cache.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(toolName).toBe('zendesk_report');
    expect(cached.tickets).toHaveLength(1);
    expect(cached.ticket_metric_events).toHaveLength(3);
    expect(cached.satisfaction_ratings).toHaveLength(1);
    expect(cached.report.slaBreachTotal).toBe(1);
  });

  it('defaults endTime to the injected clock', async () => {
    const client = routedClient();
    const nowMs = Date.UTC(2026, 6, 31, 23, 59);
    const r = await report(client, cacheStub(), { startTime }, DEFAULT_BUSINESS_HOURS, 'standard', nowMs);
    expect(r.summary).toContain('Ticket volume');
  });

  it('rejects a non-positive start_time', async () => {
    await expect(report(routedClient(), cacheStub(), { startTime: 0 }, DEFAULT_BUSINESS_HOURS, 'standard')).rejects.toThrow(/start_time/i);
  });

  it('rejects an inverted range (end_time before start_time) with an actionable error', async () => {
    await expect(
      report(routedClient(), cacheStub(), { startTime, endTime: startTime - 1 }, DEFAULT_BUSINESS_HOURS, 'standard'),
    ).rejects.toThrow(/end_time.*start_time/i);
  });
});
