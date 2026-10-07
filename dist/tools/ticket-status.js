// src/tools/ticket-status.ts
// The lifecycle table in skills/ticket-manager/SKILL.md:37-44 is enforced here, not only
// described (#61). Every ❌ cell of that 6×6 table reduces to two rules:
//   - `closed` is terminal: a closed ticket takes no further status change (SKILL.md:47).
//   - `new` is the birth state: no ticket moves back to it (SKILL.md:48).
// The `via system` column (→ closed) is NOT a ❌ — it is allowed and only worth confirming, which
// is a conversation rule the skill owns, not a tool boundary.
import { z } from 'zod';
export const FOLLOWUP_HINT = 'To carry its context forward, create a linked follow-up instead: zendesk_create_ticket with followupSourceId, or zendesk_create_tickets_bulk with via_followup_source_id.';
// null = allowed. A string is the refusal, naming the transition and why it is refused.
// `current` undefined/null means "not known yet". → new is refused whatever the current status is
// (new → new is the diagonal, not a transition), so it needs no read; the terminal-closed rule does.
export function transitionRefusal(current, target) {
    if (target === undefined)
        return null;
    if (target === 'new') {
        return 'Refusing to set status `new`: it is the birth state only and cannot be set on an existing ticket.';
    }
    if (current === 'closed' && target !== 'closed') {
        return `Refusing the status transition closed → ${target}: a closed ticket is terminal and cannot be reopened or edited. ${FOLLOWUP_HINT}`;
    }
    return null;
}
const StatusSchema = z.object({ status: z.string().nullish() });
// The current status of one ticket, or null when the response does not carry one. This is a
// lifecycle guard, not a security boundary: an unparseable read must not block a legitimate
// update, so an unknown status is treated as "not closed" and only the → new rule still applies.
export async function readStatus(client, ticketId) {
    const raw = await client.request(`/tickets/${ticketId}.json`);
    const parsed = z.object({ ticket: StatusSchema }).safeParse(raw);
    return parsed.success ? parsed.data.ticket.status ?? null : null;
}
// Current statuses for a batch, by id. Ids missing from the response stay absent → unknown.
export async function readStatuses(client, ids) {
    const raw = await client.request(`/tickets/show_many.json?ids=${encodeURIComponent(ids.join(','))}`);
    const parsed = z.object({ tickets: z.array(StatusSchema.extend({ id: z.number() })) }).safeParse(raw);
    return new Map(parsed.success ? parsed.data.tickets.map((t) => [t.id, t.status ?? null]) : []);
}
