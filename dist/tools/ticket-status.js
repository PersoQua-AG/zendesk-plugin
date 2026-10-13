// src/tools/ticket-status.ts
// The lifecycle table in skills/ticket-manager/SKILL.md:37-44 is enforced here, not only
// described (#61). Every refused cell reduces to two rules from the prose beneath it: `closed` is
// terminal (SKILL.md:47) and `new` is the birth state (SKILL.md:48), both including their own
// status (owner decision 2026-10-07). The `via system` column (→ closed) is allowed.
import { z } from 'zod';
// The six statuses SKILL.md:37-44 publishes — the one source for the guard and for the enums
// in src/register/tickets.ts, so a status added to one cannot be missing from the other.
export const TICKET_STATUSES = ['new', 'open', 'pending', 'hold', 'solved', 'closed'];
export const BIRTH_STATE_REFUSAL = 'Refusing to set status `new`: it is the birth state only and cannot be set on an existing ticket.';
// The single place a transition is judged; both tool paths route their decision through it.
export function refusalReason(current, target) {
    if (target === 'new')
        return 'birth-state';
    if (current === null)
        return 'unreadable';
    // Positive list: a status outside the published six is refused, never assumed to be "not closed".
    if (!TICKET_STATUSES.includes(current))
        return 'unpublished';
    if (current === 'closed')
        return 'terminal';
    return null;
}
// null = allowed; a string is the single-path refusal, naming the transition and why.
export function transitionRefusal(current, target) {
    switch (refusalReason(current, target)) {
        case 'birth-state':
            return BIRTH_STATE_REFUSAL;
        case 'unreadable':
            return `Refusing the status transition to ${target}: the ticket's current status could not be read, so the lifecycle rules cannot be checked and a closed ticket would be edited unnoticed. Read the ticket again and retry.`;
        case 'unpublished':
            return `Refusing the status transition to ${target}: the ticket's current status is not one of the published statuses (${TICKET_STATUSES.join(', ')}), so the lifecycle rules cannot be checked and a closed ticket would be edited unnoticed. Read the ticket again and retry.`;
        case 'terminal':
            return `Refusing the status transition closed → ${target}: a closed ticket is terminal and cannot be reopened or edited. To carry its context forward, create a linked follow-up instead: zendesk_create_ticket with followupSourceId, or zendesk_create_tickets_bulk with via_followup_source_id.`;
        default:
            return null;
    }
}
const StatusSchema = z.object({ status: z.string().nullish() });
const BatchStatusSchema = StatusSchema.extend({ id: z.number() });
// The current status of THE ticket asked for, or null — an answer about another id is not an answer.
export async function readStatus(client, ticketId) {
    const raw = await client.request(`/tickets/${ticketId}.json`);
    const parsed = z.object({ ticket: BatchStatusSchema }).safeParse(raw);
    return parsed.success && parsed.data.ticket.id === ticketId ? parsed.data.ticket.status ?? null : null;
}
// Current statuses for a batch, by id. Parsed per RECORD, not per response: validating the whole
// array at once means one malformed ticket empties the map and every id then looks unknown. An id
// with no readable status is ABSENT rather than null, which refusalReason reads as unreadable.
export async function readStatuses(client, ids) {
    const raw = await client.request(`/tickets/show_many.json?ids=${encodeURIComponent(ids.join(','))}`);
    const envelope = z.object({ tickets: z.array(z.unknown()) }).safeParse(raw);
    const statuses = new Map();
    if (!envelope.success)
        return statuses;
    for (const record of envelope.data.tickets) {
        const parsed = BatchStatusSchema.safeParse(record);
        if (parsed.success && parsed.data.status != null)
            statuses.set(parsed.data.id, parsed.data.status);
    }
    return statuses;
}
