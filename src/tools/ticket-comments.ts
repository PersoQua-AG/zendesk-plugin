// src/tools/ticket-comments.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { cbpPageSchema, collectCbp, type CbpPage } from '../client/paginator.js';
import type { SecurityLevel } from '../security/screen.js';
import { summariseScreened, type RecordScreen, type Screener } from './screening.js';
import { buildComment } from './tickets.js';
import type { ReadResult } from './result.js';

export async function addComment(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { ticketId: number; body: string; public?: boolean; markdown?: boolean },
): Promise<{ summary: string; cacheHandle: string }> {
  if (params.body.trim() === '') throw new Error('Comment body must not be empty.');
  const isPublic = params.public ?? true;
  const comment = buildComment(params.body, params.markdown ?? true, isPublic);
  const raw = await client.request<{ ticket: { id: number } }>(`/tickets/${params.ticketId}.json`, {
    method: 'PUT',
    body: JSON.stringify({ ticket: { comment } }),
  });
  const entry = cache.save('zendesk_add_comment', raw);
  return { summary: `Added ${isPublic ? 'public' : 'internal'} comment to ticket #${params.ticketId}`, cacheHandle: entry.handle };
}

const CommentSchema = z.object({
  id: z.number(),
  author_id: z.number().nullish(),
  public: z.boolean().nullish(),
  body: z.string().nullish(),
});
type Comment = z.infer<typeof CommentSchema>;

const CommentsPageSchema = cbpPageSchema(CommentSchema, 'comments');

function describeComment(c: Comment, screen: Screener): RecordScreen<Comment> {
  const body = screen(c.body ?? '', `comment-${c.id}`);
  return {
    safe: { ...c, ...(typeof c.body === 'string' ? { body: body.wrapped } : {}) },
    line: `comment #${c.id}${c.public === false ? ' (internal)' : ''}`,
    flagged: body.flagged,
  };
}

export async function listComments(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { ticketId: number; maxRecords?: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const cap = params.maxRecords ?? 500;
  const fetchPage = async (cursor: string | null): Promise<CbpPage<Comment>> => {
    const parts = ['page[size]=100'];
    if (cursor) parts.push(`page[after]=${encodeURIComponent(cursor)}`);
    const raw = await client.request<unknown>(`/tickets/${params.ticketId}/comments.json?${parts.join('&')}`);
    const parsed = CommentsPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unexpected /tickets/{id}/comments response shape.');
    return { records: parsed.data.comments, meta: parsed.data.meta, links: { next: parsed.data.links?.next ?? null } };
  };

  const capped = await collectCbp(fetchPage, cap);
  const screened = summariseScreened(capped, describeComment, securityLevel);
  const entry = cache.save('zendesk_list_comments', { comments: screened.records });
  return {
    summary: `${screened.records.length} comment(s) on ticket #${params.ticketId}${screened.warning}`,
    cacheHandle: entry.handle,
    flagged: screened.flagged,
  };
}
