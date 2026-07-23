// src/tools/ticket-audits.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import type { SecurityLevel } from '../security/screen.js';
import { screenRecordDeep, type RecordScreen, type Screener } from './screening.js';
import { listCbp } from './cbp-list.js';
import type { ReadResult } from './result.js';

const AuditSchema = z.object({ id: z.number(), events: z.array(z.record(z.unknown())).nullish() });
type Audit = z.infer<typeof AuditSchema>;

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
  return listCbp<Audit>({
    client,
    cache,
    securityLevel,
    path: `/tickets/${params.ticketId}/audits.json`,
    key: 'audits',
    schema: AuditSchema,
    describe: describeAudit,
    handle: 'zendesk_get_ticket_audits',
    cap: params.maxRecords ?? 500,
    summary: (n) => `${n} audit(s) for ticket #${params.ticketId}`,
    errorLabel: '/tickets/{id}/audits',
  });
}
