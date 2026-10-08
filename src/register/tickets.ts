// src/register/tickets.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { okWithHandle, toText } from '../tools/result.js';
import { listTickets, getTicket, getTicketsMany, createTicket, updateTicket } from '../tools/tickets.js';
import { addComment, listComments } from '../tools/ticket-comments.js';
import { addTicketTags } from '../tools/ticket-tags.js';
import { createTicketsBulk, updateTicketsBulk } from '../tools/ticket-bulk.js';
import { TICKET_STATUSES } from '../tools/ticket-status.js';
import { getTicketAudits } from '../tools/ticket-audits.js';
import { listTicketFields, listTicketForms } from '../tools/ticket-metadata.js';
import { uploadAttachment, MAX_UPLOAD_BASE64_CHARS } from '../tools/uploads.js';
import type { ToolContext } from './context.js';

// Shared by single-update and bulk-update so the two paths validate symmetrically. `new` stays in
// the enum although #61 always refuses it: the tool's sentence beats a zod type error.
const ticketUpdateFieldsSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  assignee_id: z.number().int().positive().optional(),
  group_id: z.number().int().positive().optional(),
  subject: z.string().optional(),
  tags: z.array(z.string()).optional(),
  custom_fields: z.array(z.object({ id: z.number(), value: z.unknown() })).optional(),
});

// Per-record schema for bulk create: the shared update field surface plus the create-only
// fields (subject required, a comment), so bulk-create validation is symmetric with the
// single-create/-update tools instead of forwarding arbitrary objects to create_many. The only
// escape valve is a custom field's `value`, which is genuinely open-typed.
// #66: `.strict()` is the mechanism, not the declaration below. Both create surfaces already
// PUBLISH additionalProperties:false, while the zod parse stripped an undeclared key and the tool
// reported success — so a mistyped key name silently created an unlinked follow-up. Strict makes
// the runtime keep the contract the schema advertises, for every field and not just this one.
const bulkCreateTicketSchema = ticketUpdateFieldsSchema
  .extend({
    subject: z.string().min(1),
    comment: z
      .object({
        body: z.string().min(1).optional(),
        html_body: z.string().min(1).optional(),
        // #64: bulk create hands its records straight to create_many, where Zendesk's own
        // default would publish the comment. The schema is the one funnel every record passes,
        // so the internal-by-default decision is applied here as a parse default.
        public: z.boolean().optional().default(false).describe('true = the first comment is visible to the customer. Omitted = internal note (agents only).'),
      })
      .strict(),
    requester_id: z.number().int().positive().optional(),
    // Zendesk's write-only follow-up link (Tickets JSON format).
    via_followup_source_id: z.number().int().positive().optional(),
  })
  .strict();

export function registerTicketTools(server: McpServer, ctx: ToolContext): void {
  const { httpClient, cache, securityLevel, markdownDefault } = ctx;

  server.registerTool(
    'zendesk_list_tickets',
    {
      description: 'List tickets (cursor-paginated). Returns a screened summary + cache handle.',
      inputSchema: { pageSize: z.number().int().positive().max(100).optional(), maxRecords: z.number().int().positive().optional() },
    },
    async (args) => okWithHandle(await listTickets(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_get_ticket',
    { description: 'Get one ticket by id (screened). Returns updated_stamp for safe_update.', inputSchema: { ticketId: z.number().int().positive() } },
    async ({ ticketId }) => {
      const r = await getTicket(httpClient, cache, { ticketId }, securityLevel);
      return toText(`${r.summary}\nupdated_stamp: ${r.updatedStamp ?? 'unknown'}\n(cache: ${r.cacheHandle})`);
    },
  );

  server.registerTool(
    'zendesk_get_tickets_many',
    { description: 'Get multiple tickets by id (show_many, screened).', inputSchema: { ids: z.array(z.number().int().positive()).min(1) } },
    async ({ ids }) => okWithHandle(await getTicketsMany(httpClient, cache, { ids }, securityLevel)),
  );

  server.registerTool(
    'zendesk_create_ticket',
    {
      description:
        'Create a ticket. Its first comment is an INTERNAL note unless public:true is passed. The comment is converted Markdown→HTML unless markdown:false.',
      // A ZodObject rather than a raw shape, so `.strict()` reaches the top-level args too (#66).
      inputSchema: z
        .object({
          subject: z.string().min(1),
          comment: z.string().min(1),
          requesterId: z.number().int().positive().optional(),
          priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
          // A ticket is never created `closed`; the rest of the published set is derived, not retyped.
          status: z.enum(TICKET_STATUSES).exclude(['closed']).optional(),
          tags: z.array(z.string()).optional(),
          groupId: z.number().int().positive().optional(),
          assigneeId: z.number().int().positive().optional(),
          markdown: z.boolean().optional(),
          public: z.boolean().optional().default(false).describe('true = the first comment is visible to the customer. Omitted = internal note (agents only).'),
          // The id of a CLOSED ticket this one follows up on; sent as via_followup_source_id (#66).
          followupSourceId: z.number().int().positive().optional(),
        })
        .strict(),
    },
    async (args) => okWithHandle(await createTicket(httpClient, cache, { ...args, markdown: args.markdown ?? markdownDefault })),
  );

  server.registerTool(
    'zendesk_update_ticket',
    {
      description:
        'Update a ticket. Pass updatedStamp (from a prior read) for safe_update optimistic concurrency (409 → conflict result; do not overwrite without confirming). Set force:true to deliberately overwrite without a concurrency check.',
      inputSchema: {
        ticketId: z.number().int().positive(),
        fields: ticketUpdateFieldsSchema,
        updatedStamp: z.string().optional(),
        force: z.boolean().optional(),
      },
    },
    async (args) => {
      const r = await updateTicket(httpClient, cache, args, securityLevel);
      return toText(`${r.status.toUpperCase()}: ${r.summary}\n(cache: ${r.cacheHandle})`);
    },
  );

  server.registerTool(
    'zendesk_add_comment',
    {
      description:
        'Add a comment to a ticket. Visibility is opt-in: omitting public posts an INTERNAL note that only agents see — pass public:true for a reply the customer receives. Markdown→HTML unless markdown:false.',
      inputSchema: {
        ticketId: z.number().int().positive(),
        body: z.string().min(1),
        public: z.boolean().optional().default(false).describe('true = visible to the customer. Omitted = internal note (agents only).'),
        markdown: z.boolean().optional(),
      },
    },
    async (args) => okWithHandle(await addComment(httpClient, cache, { ...args, markdown: args.markdown ?? markdownDefault }, securityLevel)),
  );

  server.registerTool(
    'zendesk_list_comments',
    { description: 'List a ticket’s comments (cursor-paginated, screened).', inputSchema: { ticketId: z.number().int().positive(), maxRecords: z.number().int().positive().optional() } },
    async (args) => okWithHandle(await listComments(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_add_ticket_tags',
    { description: 'Add tags to a ticket. Appends by default; set replace:true to overwrite the full set.', inputSchema: { ticketId: z.number().int().positive(), tags: z.array(z.string()).min(1), replace: z.boolean().optional() } },
    async (args) => okWithHandle(await addTicketTags(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_create_tickets_bulk',
    {
      description:
        'Create up to 100 tickets in one async job (auto-polled; returns a per-record failure table). Each record’s first comment is an INTERNAL note unless comment.public:true is passed.',
      inputSchema: { tickets: z.array(bulkCreateTicketSchema).min(1).max(100) },
    },
    async ({ tickets }) => {
      const r = await createTicketsBulk(httpClient, cache, { tickets }, {}, securityLevel);
      return toText(`${r.summary} failures=${JSON.stringify(r.failures)}\n(cache: ${r.cacheHandle})`);
    },
  );

  server.registerTool(
    'zendesk_update_tickets_bulk',
    {
      description:
        'Update up to 100 tickets with shared fields in one async job (auto-polled). Bulk update_many skips per-ticket optimistic-concurrency (safe_update), so it requires force:true to acknowledge that concurrent changes may be silently overwritten.',
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).max(100),
        fields: ticketUpdateFieldsSchema,
        force: z.boolean().optional(),
      },
    },
    async ({ ids, fields, force }) => {
      const r = await updateTicketsBulk(httpClient, cache, { ids, fields, force }, {}, securityLevel);
      return toText(`${r.summary} failures=${JSON.stringify(r.failures)}\n(cache: ${r.cacheHandle})`);
    },
  );

  server.registerTool(
    'zendesk_get_ticket_audits',
    { description: 'Get a ticket’s audit trail (cursor-paginated, screened).', inputSchema: { ticketId: z.number().int().positive(), maxRecords: z.number().int().positive().optional() } },
    async (args) => okWithHandle(await getTicketAudits(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_list_ticket_fields',
    { description: 'List configured ticket fields.' },
    async () => okWithHandle(await listTicketFields(httpClient, cache)),
  );

  server.registerTool(
    'zendesk_list_ticket_forms',
    { description: 'List ticket forms (Enterprise-gated; degrades gracefully when unavailable).' },
    async () => {
      const r = await listTicketForms(httpClient, cache);
      return r.cacheHandle ? okWithHandle({ summary: r.summary, cacheHandle: r.cacheHandle }) : toText(r.summary);
    },
  );

  server.registerTool(
    'zendesk_upload_attachment',
    {
      description: 'Upload a file (base64) and return an upload token for attaching to a comment.',
      inputSchema: { filename: z.string().min(1), contentBase64: z.string().min(1).max(MAX_UPLOAD_BASE64_CHARS), contentType: z.string().optional() },
    },
    async (args) => toText(`Upload token: ${(await uploadAttachment(httpClient, args)).token}`),
  );
}
