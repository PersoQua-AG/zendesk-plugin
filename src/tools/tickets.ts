// src/tools/tickets.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import type { SecurityLevel } from '../security/screen.js';
import { makeDescribe, makeScreener, screenRecordDeep, summariseScreened, SCREEN_WARNING } from './screening.js';
import { listCbp, DEFAULT_LIST_CAP } from './cbp-list.js';
import { markdownToHtml } from '../util/markdown.js';
import { safeUpdateWithConflict } from './write-helpers.js';
import type { ReadResult } from './result.js';

const TicketSchema = z.object({
  id: z.number(),
  subject: z.string().nullish(),
  description: z.string().nullish(),
  status: z.string().nullish(),
  priority: z.string().nullish(),
  updated_at: z.string().nullish(),
});
export type Ticket = z.infer<typeof TicketSchema>;

// A ticket carries untrusted free text in subject/description (both in ALWAYS_FENCE); every
// string field reaches the cache neutralized/wrapped and the line renders from the safe copy.
const describeTicket = makeDescribe<Ticket>('ticket', (t) => `#${t.id} [${t.status ?? 'unknown'}] ${t.subject ?? ''}`);

export async function listTickets(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { pageSize?: number; maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  return listCbp<Ticket>({
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

export async function getTicket(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { ticketId: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult & { updatedStamp: string | null }> {
  const raw = await client.request<unknown>(`/tickets/${params.ticketId}.json`);
  const parsed = SingleTicketSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /tickets/{id} response shape.');
  const t = parsed.data.ticket;
  const { value, flagged } = screenRecordDeep(parsed.data, (key) => `ticket-${params.ticketId}-${key}`, makeScreener(securityLevel));
  const safe = value as { ticket: Ticket };
  const entry = cache.save('zendesk_get_ticket', safe);
  const warning = flagged ? SCREEN_WARNING : '';
  const summary = `Ticket #${t.id} [${t.status ?? 'unknown'}] priority=${t.priority ?? 'none'}\nSubject: ${safe.ticket.subject ?? ''}\nDescription: ${safe.ticket.description ?? ''}${warning}`;
  return { summary, cacheHandle: entry.handle, flagged, updatedStamp: t.updated_at ?? null };
}

const ManyTicketsSchema = z.object({ tickets: z.array(TicketSchema) });

export async function getTicketsMany(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { ids: number[] },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  if (params.ids.length === 0) throw new Error('At least one ticket id is required.');
  const raw = await client.request<unknown>(`/tickets/show_many.json?ids=${encodeURIComponent(params.ids.join(','))}`);
  const parsed = ManyTicketsSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /tickets/show_many response shape.');
  const screened = summariseScreened(parsed.data.tickets, describeTicket, securityLevel);
  const entry = cache.save('zendesk_get_tickets_many', { tickets: screened.records });
  return {
    summary: `${screened.records.length} ticket(s):\n${screened.lines.join('\n')}${screened.warning}`,
    cacheHandle: entry.handle,
    flagged: screened.flagged,
  };
}

export interface NewTicketInput {
  subject: string;
  comment: string;
  requesterId?: number;
  priority?: string;
  status?: string;
  tags?: string[];
  groupId?: number;
  assigneeId?: number;
  // Resolved boolean (register applies the markdown_conversion default); no hidden tool default.
  markdown: boolean;
  public?: boolean;
}

export function buildComment(text: string, useMarkdown: boolean, isPublic: boolean): Record<string, unknown> {
  return useMarkdown
    ? { html_body: markdownToHtml(text), public: isPublic }
    : { body: text, public: isPublic };
}

export async function createTicket(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: NewTicketInput,
): Promise<{ summary: string; cacheHandle: string }> {
  const ticket: Record<string, unknown> = {
    subject: params.subject,
    comment: buildComment(params.comment, params.markdown, params.public ?? true),
  };
  if (params.requesterId !== undefined) ticket.requester_id = params.requesterId;
  if (params.priority) ticket.priority = params.priority;
  if (params.status) ticket.status = params.status;
  if (params.tags) ticket.tags = params.tags;
  if (params.groupId !== undefined) ticket.group_id = params.groupId;
  if (params.assigneeId !== undefined) ticket.assignee_id = params.assigneeId;

  const raw = await client.request<{ ticket: { id: number } }>('/tickets.json', {
    method: 'POST',
    body: JSON.stringify({ ticket }),
  });
  const entry = cache.save('zendesk_create_ticket', raw);
  return { summary: `Created ticket #${raw.ticket.id}`, cacheHandle: entry.handle };
}

export interface TicketUpdateFields {
  status?: string;
  priority?: string;
  assignee_id?: number;
  group_id?: number;
  subject?: string;
  tags?: string[];
  custom_fields?: Array<{ id: number; value?: unknown }>;
}

export type UpdateTicketResult =
  | { status: 'updated'; summary: string; cacheHandle: string }
  | { status: 'conflict'; summary: string; cacheHandle: string; currentUpdatedStamp: string | null };

export async function updateTicket(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { ticketId: number; fields: TicketUpdateFields; updatedStamp?: string; force?: boolean },
  securityLevel: SecurityLevel = 'standard',
): Promise<UpdateTicketResult> {
  // Safe-by-default (PRD §5.2): a field update requires the last-known updatedStamp for
  // optimistic concurrency (Zendesk 409s on conflict). `force:true` is the explicit,
  // documented escape hatch that deliberately overwrites without a concurrency check —
  // mirroring the append-tags/replace:true pattern.
  if (!params.updatedStamp && !params.force) {
    throw new Error(
      'Refusing to update ticket without an updatedStamp: pass the updatedStamp from a prior read to enable safe optimistic-concurrency (recommended), or set force:true to deliberately overwrite without a concurrency check.',
    );
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
    conflictSummary: ({ status, subject }) =>
      `Conflict: ticket #${params.ticketId} changed since last read (current status: ${status ?? 'unknown'}, subject: ${subject ?? '(none)'}). Re-fetch, review the diff, and confirm before overwriting.`,
  });
  // updateTicket's success arm is labelled 'updated' (macro apply uses 'applied'); the conflict
  // arm passes through unchanged.
  return result.status === 'applied'
    ? { status: 'updated', summary: result.summary, cacheHandle: result.cacheHandle }
    : result;
}
