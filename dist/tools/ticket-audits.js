// src/tools/ticket-audits.ts
import { z } from 'zod';
import { screenRecordDeep } from './screening.js';
import { listCbp } from './cbp-list.js';
const AuditSchema = z.object({ id: z.number(), events: z.array(z.record(z.unknown())).nullish() });
// Screen every free-text field on every event, field-agnostically: an event can carry
// prose in fields far beyond a fixed allowlist (plain_body, previous_value, subject,
// transcription_text, …). screenRecordDeep fences known prose fields and any other string
// that trips an injection detector, so no field name can be added later to smuggle a raw
// payload into the cache and out through zendesk_query.
function describeAudit(a, screen) {
    const events = a.events ?? [];
    const { value, flagged } = screenRecordDeep({ ...a, events }, (key) => `audit-${a.id}-${key}`, screen);
    return { safe: value, line: `audit #${a.id} (${events.length} event(s))`, flagged };
}
export async function getTicketAudits(client, cache, params, securityLevel = 'standard') {
    return listCbp({
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
