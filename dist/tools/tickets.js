// src/tools/tickets.ts
import { z } from 'zod';
import { makeDescribe, makeScreener, screenRecordDeep, summariseScreened, screenNote } from './screening.js';
import { listCbp, DEFAULT_LIST_CAP } from './cbp-list.js';
import { markdownToHtml } from '../util/markdown.js';
import { safeUpdateWithConflict } from './write-helpers.js';
import { readStatus, transitionRefusal, BIRTH_STATE_REFUSAL } from './ticket-status.js';
const TicketSchema = z.object({
    id: z.number(),
    subject: z.string().nullish(),
    description: z.string().nullish(),
    status: z.string().nullish(),
    priority: z.string().nullish(),
    updated_at: z.string().nullish(),
});
// A ticket carries untrusted free text in subject/description (both in ALWAYS_FENCE); every
// string field reaches the cache neutralized/wrapped and the line renders from the safe copy.
const describeTicket = makeDescribe('ticket', (t) => `#${t.id} [${t.status ?? 'unknown'}] ${t.subject ?? ''}`);
export async function listTickets(client, cache, params = {}, securityLevel = 'standard') {
    return listCbp({
        client,
        cache,
        securityLevel,
        path: '/tickets.json',
        key: 'tickets',
        schema: TicketSchema,
        describe: describeTicket,
        handle: 'zendesk_list_tickets',
        cap: params.maxRecords ?? DEFAULT_LIST_CAP,
        pageSize: params.pageSize,
        label: (n) => `${n} ticket(s)`,
        errorLabel: '/tickets',
    });
}
const SingleTicketSchema = z.object({ ticket: TicketSchema });
export async function getTicket(client, cache, params, securityLevel = 'standard') {
    const raw = await client.request(`/tickets/${params.ticketId}.json`);
    const parsed = SingleTicketSchema.safeParse(raw);
    if (!parsed.success)
        throw new Error('Unexpected /tickets/{id} response shape.');
    const t = parsed.data.ticket;
    const { value, flagged } = screenRecordDeep(parsed.data, (key) => `ticket-${params.ticketId}-${key}`, makeScreener(securityLevel));
    const safe = value;
    const entry = cache.save('zendesk_get_ticket', safe);
    const warning = screenNote(flagged, securityLevel);
    const summary = `Ticket #${t.id} [${t.status ?? 'unknown'}] priority=${t.priority ?? 'none'}\nSubject: ${safe.ticket.subject ?? ''}\nDescription: ${safe.ticket.description ?? ''}${warning}`;
    return { summary, cacheHandle: entry.handle, flagged, updatedStamp: t.updated_at ?? null };
}
const ManyTicketsSchema = z.object({ tickets: z.array(TicketSchema) });
export async function getTicketsMany(client, cache, params, securityLevel = 'standard') {
    if (params.ids.length === 0)
        throw new Error('At least one ticket id is required.');
    const raw = await client.request(`/tickets/show_many.json?ids=${encodeURIComponent(params.ids.join(','))}`);
    const parsed = ManyTicketsSchema.safeParse(raw);
    if (!parsed.success)
        throw new Error('Unexpected /tickets/show_many response shape.');
    const screened = summariseScreened(parsed.data.tickets, describeTicket, securityLevel);
    const entry = cache.save('zendesk_get_tickets_many', { tickets: screened.records });
    return {
        summary: `${screened.records.length} ticket(s):\n${screened.lines.join('\n')}${screened.warning}`,
        cacheHandle: entry.handle,
        flagged: screened.flagged,
    };
}
// #64: visibility is opt-in. An omitted `public` means an INTERNAL note, because publishing an
// internal remark to the customer cannot be undone while an internal note can be reposted.
// This function has exactly two callers, and they are the only surfaces whose default is resolved
// here: addComment (src/tools/ticket-comments.ts) and createTicket below.
// zendesk_create_tickets_bulk bypasses it — it forwards raw Zendesk records to create_many, so its
// default is a PUBLISHED one in the registered schema (bulkCreateTicketSchema in
// src/register/tickets.ts) rather than a runtime one. zendesk_apply_macro_to_ticket
// (applyMacroToTicket in src/tools/business-rules/macros.ts) PUTs the macro preview's comment
// verbatim and resolves NO default; that is scoped out of #64 because the macro's author chooses
// the visibility in Zendesk and the model cannot set the flag at all — tracked in #116.
// Four comment-writing surfaces, three defaults, two of them here. Symbols, not line numbers:
// a line number in a comment is unchecked and drifts (the same reason tm-9-failcheck lost its own).
export function buildComment(text, useMarkdown, isPublic = false) {
    return useMarkdown
        ? { html_body: markdownToHtml(text), public: isPublic }
        : { body: text, public: isPublic };
}
export async function createTicket(client, cache, params) {
    const ticket = {
        subject: params.subject,
        comment: buildComment(params.comment, params.markdown, params.public),
    };
    if (params.requesterId !== undefined)
        ticket.requester_id = params.requesterId;
    if (params.priority)
        ticket.priority = params.priority;
    if (params.status)
        ticket.status = params.status;
    if (params.tags)
        ticket.tags = params.tags;
    if (params.groupId !== undefined)
        ticket.group_id = params.groupId;
    if (params.assigneeId !== undefined)
        ticket.assignee_id = params.assigneeId;
    if (params.followupSourceId !== undefined)
        ticket.via_followup_source_id = params.followupSourceId;
    const raw = await client.request('/tickets.json', {
        method: 'POST',
        body: JSON.stringify({ ticket }),
    });
    const entry = cache.save('zendesk_create_ticket', raw);
    return { summary: `Created ticket #${raw.ticket.id}`, cacheHandle: entry.handle };
}
export async function updateTicket(client, cache, params, securityLevel = 'standard') {
    // Safe-by-default (PRD §5.2): a field update requires the last-known updatedStamp for
    // optimistic concurrency (Zendesk 409s on conflict). `force:true` is the explicit,
    // documented escape hatch that deliberately overwrites without a concurrency check —
    // mirroring the append-tags/replace:true pattern.
    if (!params.updatedStamp && !params.force) {
        throw new Error('Refusing to update ticket without an updatedStamp: pass the updatedStamp from a prior read to enable safe optimistic-concurrency (recommended), or set force:true to deliberately overwrite without a concurrency check.');
    }
    // #61: the lifecycle table is enforced before any write, force:true included — force acknowledges
    // a concurrency overwrite, not an impossible transition. → new needs no read, so it skips one.
    const target = params.fields.status;
    if (target !== undefined) {
        const refusal = target === 'new' ? BIRTH_STATE_REFUSAL : transitionRefusal(await readStatus(client, params.ticketId), target);
        if (refusal)
            throw new Error(refusal);
    }
    const result = await safeUpdateWithConflict(client, cache, {
        path: `/tickets/${params.ticketId}.json`,
        envelopeKey: 'ticket',
        body: { ...params.fields },
        updatedStamp: params.updatedStamp,
        force: params.force,
        toolName: 'zendesk_update_ticket',
        seedPrefix: `update-ticket-${params.ticketId}`,
        securityLevel,
        appliedSummary: `Updated ticket #${params.ticketId}`,
        conflictSummary: ({ status, subject }) => `Conflict: ticket #${params.ticketId} changed since last read (current status: ${status ?? 'unknown'}, subject: ${subject ?? '(none)'}). Re-fetch, review the diff, and confirm before overwriting.`,
    });
    // updateTicket's success arm is labelled 'updated' (macro apply uses 'applied'); the conflict
    // arm passes through unchanged.
    return result.status === 'applied'
        ? { status: 'updated', summary: result.summary, cacheHandle: result.cacheHandle }
        : result;
}
