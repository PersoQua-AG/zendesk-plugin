// src/tools/ticket-audits.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { cbpPageSchema, collectCbp, type CbpPage } from '../client/paginator.js';
import type { SecurityLevel } from '../security/screen.js';
import { summariseScreened, type RecordScreen, type Screener } from './screening.js';
import type { ReadResult } from './result.js';

const AuditSchema = z.object({ id: z.number(), events: z.array(z.record(z.unknown())).nullish() });
type Audit = z.infer<typeof AuditSchema>;

const AuditsPageSchema = cbpPageSchema(AuditSchema, 'audits');

// Untrusted free-text on an audit event: the comment body, the changed value, and a
// rich-text comment's html_body. All are rewritten to their wrapped form on ingest.
const UNTRUSTED_EVENT_FIELDS = ['body', 'value', 'html_body'] as const;

function screenEvent(event: Record<string, unknown>, auditId: number, screen: Screener) {
  const screened = UNTRUSTED_EVENT_FIELDS.filter((field) => typeof event[field] === 'string').map((field) => ({
    field,
    result: screen(event[field] as string, `audit-${auditId}-${field}`),
  }));
  const safe: Record<string, unknown> = { ...event };
  for (const { field, result } of screened) safe[field] = result.wrapped;
  return { safe, flagged: screened.some(({ result }) => result.flagged) };
}

function describeAudit(a: Audit, screen: Screener): RecordScreen<Audit> {
  const events = (a.events ?? []).map((event) => screenEvent(event, a.id, screen));
  return {
    safe: { ...a, events: events.map((e) => e.safe) },
    line: `audit #${a.id} (${events.length} event(s))`,
    flagged: events.some((e) => e.flagged),
  };
}

export async function getTicketAudits(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { ticketId: number; maxRecords?: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const cap = params.maxRecords ?? 500;
  const fetchPage = async (cursor: string | null): Promise<CbpPage<Audit>> => {
    const parts = ['page[size]=100'];
    if (cursor) parts.push(`page[after]=${encodeURIComponent(cursor)}`);
    const raw = await client.request<unknown>(`/tickets/${params.ticketId}/audits.json?${parts.join('&')}`);
    const parsed = AuditsPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unexpected /tickets/{id}/audits response shape.');
    return { records: parsed.data.audits, meta: parsed.data.meta, links: { next: parsed.data.links?.next ?? null } };
  };

  const capped = await collectCbp(fetchPage, cap);
  const screened = summariseScreened(capped, describeAudit, securityLevel);
  const entry = cache.save('zendesk_get_ticket_audits', { audits: screened.records });
  return {
    summary: `${screened.records.length} audit(s) for ticket #${params.ticketId}${screened.warning}`,
    cacheHandle: entry.handle,
    flagged: screened.flagged,
  };
}
