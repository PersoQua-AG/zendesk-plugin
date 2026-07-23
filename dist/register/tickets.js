import { z } from 'zod';
import { okWithHandle, toText } from '../tools/result.js';
import { listTickets, getTicket, getTicketsMany, createTicket, updateTicket } from '../tools/tickets.js';
import { addComment, listComments } from '../tools/ticket-comments.js';
import { addTicketTags } from '../tools/ticket-tags.js';
import { createTicketsBulk, updateTicketsBulk } from '../tools/ticket-bulk.js';
import { getTicketAudits } from '../tools/ticket-audits.js';
import { listTicketFields, listTicketForms } from '../tools/ticket-metadata.js';
import { uploadAttachment, MAX_UPLOAD_BASE64_CHARS } from '../tools/uploads.js';
// Single source of truth for ticket-field update validation, shared by single-update
// and bulk-update so the two paths validate symmetrically.
const ticketUpdateFieldsSchema = z.object({
    status: z.enum(['new', 'open', 'pending', 'hold', 'solved', 'closed']).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    assignee_id: z.number().int().positive().optional(),
    group_id: z.number().int().positive().optional(),
    subject: z.string().optional(),
    tags: z.array(z.string()).optional(),
    custom_fields: z.array(z.object({ id: z.number(), value: z.unknown() })).optional(),
});
export function registerTicketTools(server, ctx) {
    const { httpClient, cache, securityLevel, markdownDefault } = ctx;
    server.registerTool('zendesk_list_tickets', {
        description: 'List tickets (cursor-paginated). Returns a screened summary + cache handle.',
        inputSchema: { pageSize: z.number().int().positive().max(100).optional(), maxRecords: z.number().int().positive().optional() },
    }, async (args) => okWithHandle(await listTickets(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_get_ticket', { description: 'Get one ticket by id (screened). Returns updated_stamp for safe_update.', inputSchema: { ticketId: z.number().int().positive() } }, async ({ ticketId }) => {
        const r = await getTicket(httpClient, cache, { ticketId }, securityLevel);
        return toText(`${r.summary}\nupdated_stamp: ${r.updatedStamp ?? 'unknown'}\n(cache: ${r.cacheHandle})`);
    });
    server.registerTool('zendesk_get_tickets_many', { description: 'Get multiple tickets by id (show_many, screened).', inputSchema: { ids: z.array(z.number().int().positive()).min(1) } }, async ({ ids }) => okWithHandle(await getTicketsMany(httpClient, cache, { ids }, securityLevel)));
    server.registerTool('zendesk_create_ticket', {
        description: 'Create a ticket. The comment is converted Markdown→HTML unless markdown:false.',
        inputSchema: {
            subject: z.string().min(1),
            comment: z.string().min(1),
            requesterId: z.number().int().positive().optional(),
            priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
            status: z.enum(['new', 'open', 'pending', 'hold', 'solved']).optional(),
            tags: z.array(z.string()).optional(),
            groupId: z.number().int().positive().optional(),
            assigneeId: z.number().int().positive().optional(),
            markdown: z.boolean().optional(),
            public: z.boolean().optional(),
        },
    }, async (args) => okWithHandle(await createTicket(httpClient, cache, { ...args, markdown: args.markdown ?? markdownDefault })));
    server.registerTool('zendesk_update_ticket', {
        description: 'Update a ticket. Pass updatedStamp (from a prior read) for safe_update optimistic concurrency (409 → conflict result; do not overwrite without confirming). Set force:true to deliberately overwrite without a concurrency check.',
        inputSchema: {
            ticketId: z.number().int().positive(),
            fields: ticketUpdateFieldsSchema,
            updatedStamp: z.string().optional(),
            force: z.boolean().optional(),
        },
    }, async (args) => {
        const r = await updateTicket(httpClient, cache, args, securityLevel);
        return toText(`${r.status.toUpperCase()}: ${r.summary}\n(cache: ${r.cacheHandle})`);
    });
    server.registerTool('zendesk_add_comment', {
        description: 'Add a public or internal comment to a ticket (Markdown→HTML unless markdown:false).',
        inputSchema: { ticketId: z.number().int().positive(), body: z.string().min(1), public: z.boolean().optional(), markdown: z.boolean().optional() },
    }, async (args) => okWithHandle(await addComment(httpClient, cache, { ...args, markdown: args.markdown ?? markdownDefault }, securityLevel)));
    server.registerTool('zendesk_list_comments', { description: 'List a ticket’s comments (cursor-paginated, screened).', inputSchema: { ticketId: z.number().int().positive(), maxRecords: z.number().int().positive().optional() } }, async (args) => okWithHandle(await listComments(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_add_ticket_tags', { description: 'Add tags to a ticket. Appends by default; set replace:true to overwrite the full set.', inputSchema: { ticketId: z.number().int().positive(), tags: z.array(z.string()).min(1), replace: z.boolean().optional() } }, async (args) => okWithHandle(await addTicketTags(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_create_tickets_bulk', { description: 'Create up to 100 tickets in one async job (auto-polled; returns a per-record failure table).', inputSchema: { tickets: z.array(z.record(z.unknown())).min(1).max(100) } }, async ({ tickets }) => {
        const r = await createTicketsBulk(httpClient, cache, { tickets }, {}, securityLevel);
        return toText(`${r.summary} failures=${JSON.stringify(r.failures)}\n(cache: ${r.cacheHandle})`);
    });
    server.registerTool('zendesk_update_tickets_bulk', {
        description: 'Update up to 100 tickets with shared fields in one async job (auto-polled). Bulk update_many skips per-ticket optimistic-concurrency (safe_update), so it requires force:true to acknowledge that concurrent changes may be silently overwritten.',
        inputSchema: {
            ids: z.array(z.number().int().positive()).min(1).max(100),
            fields: ticketUpdateFieldsSchema,
            force: z.boolean().optional(),
        },
    }, async ({ ids, fields, force }) => {
        const r = await updateTicketsBulk(httpClient, cache, { ids, fields, force }, {}, securityLevel);
        return toText(`${r.summary} failures=${JSON.stringify(r.failures)}\n(cache: ${r.cacheHandle})`);
    });
    server.registerTool('zendesk_get_ticket_audits', { description: 'Get a ticket’s audit trail (cursor-paginated, screened).', inputSchema: { ticketId: z.number().int().positive(), maxRecords: z.number().int().positive().optional() } }, async (args) => okWithHandle(await getTicketAudits(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_list_ticket_fields', { description: 'List configured ticket fields.' }, async () => okWithHandle(await listTicketFields(httpClient, cache)));
    server.registerTool('zendesk_list_ticket_forms', { description: 'List ticket forms (Enterprise-gated; degrades gracefully when unavailable).' }, async () => {
        const r = await listTicketForms(httpClient, cache);
        return r.cacheHandle ? okWithHandle({ summary: r.summary, cacheHandle: r.cacheHandle }) : toText(r.summary);
    });
    server.registerTool('zendesk_upload_attachment', {
        description: 'Upload a file (base64) and return an upload token for attaching to a comment.',
        inputSchema: { filename: z.string().min(1), contentBase64: z.string().min(1).max(MAX_UPLOAD_BASE64_CHARS), contentType: z.string().optional() },
    }, async (args) => toText(`Upload token: ${(await uploadAttachment(httpClient, args)).token}`));
}
