// src/tools/ticket-audits.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { cbpPageSchema, collectCbp, type CbpPage } from '../client/paginator.js';
import type { SecurityLevel } from '../security/screen.js';
import { screenRecordDeep, summariseScreened, type RecordScreen, type Screener } from './screening.js';
import type { ReadResult } from './result.js';

const AuditSchema = z.object({ id: z.number(), events: z.array(z.record(z.unknown())).nullish() });
type Audit = z.infer<typeof AuditSchema>;

const AuditsPageSchema = cbpPageSchema(AuditSchema, 'audits');

// Screen every free-text field on every event, field-agnostically: an event can carry
// prose in fields far beyond a fixed allowlist (plain_body, previous_value, subject,
// transcription_text, …). screenRecordDeep fences known prose fields and any other string
// that trips an injection detector, so no field name can be added later to smuggle a raw
// payload into the cache and out through zendesk_query.
function describeAudit(a: Audit, screen: Screener): RecordScreen<Audit> {
  const events = a.events ?? [];
  const { value, flagged } = screenRecordDeep({ ...a, events }, (key) => `audit-${a.id}-${key}`, screen);
  return { safe: value as Audit, line: `audit #${a.id} (${events.length} event(s))`, flagged };
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
