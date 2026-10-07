// src/tools/ticket-status.ts
// The lifecycle table in skills/ticket-manager/SKILL.md:37-44 is enforced here, not only
// described (#61). Every refused cell of that 6×6 table reduces to two rules from the prose
// beneath it:
//   - `closed` is terminal: a closed ticket takes no further status change at all, closed → closed
//     included (SKILL.md:47, owner decision 2026-10-07).
//   - `new` is the birth state: no ticket moves back to it from any status, new → new included
//     (SKILL.md:48, owner decision 2026-10-07).
// The `via system` column (→ closed) is NOT refused — it is allowed and only worth confirming,
// which is a conversation rule the skill owns, not a tool boundary.
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';

// null = allowed; a string is the refusal, naming the transition and why.
// `current` is null when the status could not be read. That is NOT "probably fine": the
// terminal-closed rule is exactly the case an unreadable status hides, so an unknown status
// refuses the write rather than letting it through. The one target that needs no read at all is
// `new`, which is refused from every status and is therefore settled before `current` is consulted.
export function transitionRefusal(current: string | null, target: string): string | null {
  if (target === 'new') {
    return 'Refusing to set status `new`: it is the birth state only and cannot be set on an existing ticket.';
  }
  if (current === null) {
    return `Refusing the status transition to ${target}: the ticket's current status could not be read, so the lifecycle rules cannot be checked and a closed ticket would be edited unnoticed. Read the ticket again and retry.`;
  }
  if (current === 'closed') {
    return `Refusing the status transition closed → ${target}: a closed ticket is terminal and cannot be reopened or edited. To carry its context forward, create a linked follow-up instead: zendesk_create_ticket with followupSourceId, or zendesk_create_tickets_bulk with via_followup_source_id.`;
  }
  return null;
}

const StatusSchema = z.object({ status: z.string().nullish() });
const BatchStatusSchema = StatusSchema.extend({ id: z.number() });

// The current status of one ticket, or null when the response does not carry one.
export async function readStatus(client: ZendeskHttpClient, ticketId: number): Promise<string | null> {
  const raw = await client.request<unknown>(`/tickets/${ticketId}.json`);
  const parsed = z.object({ ticket: StatusSchema }).safeParse(raw);
  return parsed.success ? parsed.data.ticket.status ?? null : null;
}

// Current statuses for a batch, by id. Parsed per RECORD, not per response: validating the whole
// array at once means one malformed ticket empties the map, and then every id in the batch looks
// unknown. Ids missing from the response, and records that do not parse, stay absent — which
// transitionRefusal reads as unknown and refuses.
export async function readStatuses(client: ZendeskHttpClient, ids: number[]): Promise<Map<number, string | null>> {
  const raw = await client.request<unknown>(`/tickets/show_many.json?ids=${encodeURIComponent(ids.join(','))}`);
  const envelope = z.object({ tickets: z.array(z.unknown()) }).safeParse(raw);
  const statuses = new Map<number, string | null>();
  if (!envelope.success) return statuses;
  for (const record of envelope.data.tickets) {
    const parsed = BatchStatusSchema.safeParse(record);
    if (parsed.success) statuses.set(parsed.data.id, parsed.data.status ?? null);
  }
  return statuses;
}
