import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AuthManager } from './auth/auth-manager.js';
import { TokenStore } from './auth/token-store.js';
import { RateLimiter } from './client/rate-limiter.js';
import { ZendeskHttpClient } from './client/http-client.js';
import { ResponseCache } from './client/cache.js';
import { runQuery } from './client/query.js';
import type { SecurityLevel } from './security/screen.js';
import { getMe } from './tools/me.js';
import { listTickets, getTicket, getTicketsMany, createTicket, updateTicket } from './tools/tickets.js';
import { addComment, listComments } from './tools/ticket-comments.js';
import { addTicketTags } from './tools/ticket-tags.js';
import { createTicketsBulk, updateTicketsBulk } from './tools/ticket-bulk.js';
import { getTicketAudits } from './tools/ticket-audits.js';
import { listTicketFields, listTicketForms } from './tools/ticket-metadata.js';
import { uploadAttachment } from './tools/uploads.js';
import { search, searchExport, searchCount } from './tools/search.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseSecurityLevel(raw: string | undefined): SecurityLevel {
  return raw === 'strict' || raw === 'off' ? raw : 'standard';
}

// Global Markdown→HTML default (PRD §8). A per-call `markdown` argument overrides it.
function parseMarkdownDefault(raw: string | undefined): boolean {
  return raw !== 'false';
}

const subdomain = requireEnv('ZENDESK_SUBDOMAIN');
const clientId = requireEnv('ZENDESK_OAUTH_CLIENT_ID');
const clientSecret = requireEnv('ZENDESK_OAUTH_CLIENT_SECRET');
const dataDir = process.env.CLAUDE_PLUGIN_DATA ?? '.zendesk-plugin-data';
const securityLevel = parseSecurityLevel(process.env.ZENDESK_SECURITY_LEVEL);
const markdownDefault = parseMarkdownDefault(process.env.ZENDESK_MARKDOWN_CONVERSION);

const tokenStore = new TokenStore(`${dataDir}/tokens.enc`, clientSecret);
const authManager = new AuthManager(tokenStore, {
  subdomain,
  clientId,
  clientSecret,
  callbackPort: Number(process.env.ZENDESK_OAUTH_CALLBACK_PORT ?? '8976'),
  scopes: ['read', 'write'],
});
const rateLimiter = new RateLimiter({ requestsPerMinute: 400 });
const httpClient = new ZendeskHttpClient({ subdomain, authManager, rateLimiter });
const cache = new ResponseCache(`${dataDir}/cache`);

const server = new McpServer({ name: 'zendesk', version: '0.1.0' });

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

server.registerTool(
  'zendesk_get_me',
  { description: 'Return the authenticated Zendesk user and role — use to verify auth is working.' },
  async () => {
    const r = await getMe(httpClient, cache);
    return text(`${r.summary}\n(cache: ${r.cacheHandle})`);
  },
);

server.registerTool(
  'zendesk_query',
  {
    description: 'Re-extract fields from a previously cached tool response without re-fetching from Zendesk.',
    inputSchema: { cacheHandle: z.string().regex(/^[A-Za-z0-9_-]+$/), query: z.string() },
  },
  async ({ cacheHandle, query }) => text(JSON.stringify(runQuery(cache.load(cacheHandle), query), null, 2)),
);

server.registerTool(
  'zendesk_list_tickets',
  {
    description: 'List tickets (cursor-paginated). Returns a screened summary + cache handle.',
    inputSchema: { pageSize: z.number().int().positive().max(100).optional(), maxRecords: z.number().int().positive().optional() },
  },
  async (args) => {
    const r = await listTickets(httpClient, cache, args, securityLevel);
    return text(`${r.summary}\n(cache: ${r.cacheHandle})`);
  },
);

server.registerTool(
  'zendesk_get_ticket',
  { description: 'Get one ticket by id (screened). Returns updated_stamp for safe_update.', inputSchema: { ticketId: z.number().int().positive() } },
  async ({ ticketId }) => {
    const r = await getTicket(httpClient, cache, { ticketId }, securityLevel);
    return text(`${r.summary}\nupdated_stamp: ${r.updatedStamp ?? 'unknown'}\n(cache: ${r.cacheHandle})`);
  },
);

server.registerTool(
  'zendesk_get_tickets_many',
  { description: 'Get multiple tickets by id (show_many, screened).', inputSchema: { ids: z.array(z.number().int().positive()).min(1) } },
  async ({ ids }) => {
    const r = await getTicketsMany(httpClient, cache, { ids }, securityLevel);
    return text(`${r.summary}\n(cache: ${r.cacheHandle})`);
  },
);

server.registerTool(
  'zendesk_create_ticket',
  {
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
      publicComment: z.boolean().optional(),
    },
  },
  async (args) => {
    const r = await createTicket(httpClient, cache, { ...args, markdown: args.markdown ?? markdownDefault });
    return text(`${r.summary}\n(cache: ${r.cacheHandle})`);
  },
);

server.registerTool(
  'zendesk_update_ticket',
  {
    description: 'Update a ticket. Pass updatedStamp for safe_update optimistic concurrency (409 → conflict result; do not overwrite without confirming).',
    inputSchema: {
      ticketId: z.number().int().positive(),
      fields: z.object({
        status: z.enum(['new', 'open', 'pending', 'hold', 'solved', 'closed']).optional(),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
        assignee_id: z.number().int().positive().optional(),
        group_id: z.number().int().positive().optional(),
        subject: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
      updatedStamp: z.string().optional(),
    },
  },
  async (args) => {
    const r = await updateTicket(httpClient, cache, args, securityLevel);
    return text(`${r.status.toUpperCase()}: ${r.summary}\n(cache: ${r.cacheHandle})`);
  },
);

server.registerTool(
  'zendesk_add_comment',
  {
    description: 'Add a public or internal comment to a ticket (Markdown→HTML unless markdown:false).',
    inputSchema: { ticketId: z.number().int().positive(), body: z.string().min(1), public: z.boolean().optional(), markdown: z.boolean().optional() },
  },
  async (args) => {
    const r = await addComment(httpClient, cache, { ...args, markdown: args.markdown ?? markdownDefault });
    return text(`${r.summary}\n(cache: ${r.cacheHandle})`);
  },
);

server.registerTool(
  'zendesk_list_comments',
  { description: 'List a ticket’s comments (cursor-paginated, screened).', inputSchema: { ticketId: z.number().int().positive(), maxRecords: z.number().int().positive().optional() } },
  async (args) => {
    const r = await listComments(httpClient, cache, args, securityLevel);
    return text(`${r.summary}\n(cache: ${r.cacheHandle})`);
  },
);

server.registerTool(
  'zendesk_add_ticket_tags',
  { description: 'Add tags to a ticket. Appends by default; set replace:true to overwrite the full set.', inputSchema: { ticketId: z.number().int().positive(), tags: z.array(z.string()).min(1), replace: z.boolean().optional() } },
  async (args) => {
    const r = await addTicketTags(httpClient, cache, args);
    return text(`${r.summary}\n(cache: ${r.cacheHandle})`);
  },
);

server.registerTool(
  'zendesk_create_tickets_bulk',
  { description: 'Create up to 100 tickets in one async job (auto-polled; returns a per-record failure table).', inputSchema: { tickets: z.array(z.record(z.unknown())).min(1).max(100) } },
  async ({ tickets }) => {
    const r = await createTicketsBulk(httpClient, cache, { tickets });
    return text(`${r.summary} failures=${JSON.stringify(r.failures)}\n(cache: ${r.cacheHandle})`);
  },
);

server.registerTool(
  'zendesk_update_tickets_bulk',
  { description: 'Update up to 100 tickets with shared fields in one async job (auto-polled).', inputSchema: { ids: z.array(z.number().int().positive()).min(1).max(100), fields: z.record(z.unknown()) } },
  async ({ ids, fields }) => {
    const r = await updateTicketsBulk(httpClient, cache, { ids, fields });
    return text(`${r.summary} failures=${JSON.stringify(r.failures)}\n(cache: ${r.cacheHandle})`);
  },
);

server.registerTool(
  'zendesk_get_ticket_audits',
  { description: 'Get a ticket’s audit trail (cursor-paginated, screened).', inputSchema: { ticketId: z.number().int().positive(), maxRecords: z.number().int().positive().optional() } },
  async (args) => {
    const r = await getTicketAudits(httpClient, cache, args, securityLevel);
    return text(`${r.summary}\n(cache: ${r.cacheHandle})`);
  },
);

server.registerTool(
  'zendesk_list_ticket_fields',
  { description: 'List configured ticket fields.' },
  async () => {
    const r = await listTicketFields(httpClient, cache);
    return text(`${r.summary}\n(cache: ${r.cacheHandle})`);
  },
);

server.registerTool(
  'zendesk_list_ticket_forms',
  { description: 'List ticket forms (Enterprise-gated; degrades gracefully when unavailable).' },
  async () => {
    const r = await listTicketForms(httpClient, cache);
    return text(r.cacheHandle ? `${r.summary}\n(cache: ${r.cacheHandle})` : r.summary);
  },
);

server.registerTool(
  'zendesk_upload_attachment',
  { description: 'Upload a file (base64) and return an upload token for attaching to a comment.', inputSchema: { filename: z.string().min(1), contentBase64: z.string().min(1), contentType: z.string().optional() } },
  async (args) => {
    const r = await uploadAttachment(httpClient, args);
    return text(`Upload token: ${r.token}`);
  },
);

server.registerTool(
  'zendesk_search',
  { description: 'Search Zendesk (≤1000 results). Optionally set type (ticket|user|organization|group).', inputSchema: { query: z.string().min(1), type: z.string().optional(), maxResults: z.number().int().positive().max(1000).optional() } },
  async (args) => {
    const r = await search(httpClient, cache, args, securityLevel);
    return text(`${r.summary}\n(cache: ${r.cacheHandle})`);
  },
);

server.registerTool(
  'zendesk_search_export',
  { description: 'Export large search result sets (cursor-paginated). Requires a type filter.', inputSchema: { query: z.string().min(1), type: z.string().min(1), maxRecords: z.number().int().positive().optional() } },
  async (args) => {
    const r = await searchExport(httpClient, cache, args, securityLevel);
    return text(`${r.summary}\n(cache: ${r.cacheHandle})`);
  },
);

server.registerTool(
  'zendesk_search_count',
  { description: 'Count records matching a search query (no result bodies fetched).', inputSchema: { query: z.string().min(1) } },
  async ({ query }) => text((await searchCount(httpClient, { query })).summary),
);

const transport = new StdioServerTransport();
await server.connect(transport);
