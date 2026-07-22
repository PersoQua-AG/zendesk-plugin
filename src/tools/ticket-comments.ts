// src/tools/ticket-comments.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { paginateCbp, type CbpPage } from '../client/paginator.js';
import { screenContent, type SecurityLevel } from '../security/screen.js';
import { markdownToHtml } from '../util/markdown.js';
import type { ReadResult } from './tickets.js';

export async function addComment(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { ticketId: number; body: string; public?: boolean; markdown?: boolean },
): Promise<{ summary: string; cacheHandle: string }> {
  if (params.body.trim() === '') throw new Error('Comment body must not be empty.');
  const isPublic = params.public ?? true;
  const useMarkdown = params.markdown ?? true;
  const comment: Record<string, unknown> = useMarkdown
    ? { html_body: markdownToHtml(params.body), public: isPublic }
    : { body: params.body, public: isPublic };
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

const CommentsPageSchema = z.object({
  comments: z.array(CommentSchema),
  meta: z.object({ has_more: z.boolean(), after_cursor: z.string().nullable() }),
  links: z.object({ next: z.string().nullable() }).nullish(),
});

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

  const comments: Comment[] = [];
  for await (const batch of paginateCbp(fetchPage)) {
    comments.push(...batch);
    if (comments.length >= cap) break;
  }
  const capped = comments.slice(0, cap);
  const entry = cache.save('zendesk_list_comments', { comments: capped });

  let flagged = false;
  for (const c of capped) {
    if (screenContent(c.body ?? '', `comment-${c.id}`, securityLevel).flagged) flagged = true;
  }
  const warning = flagged ? ' — WARNING: injection patterns detected in comment content' : '';
  return { summary: `${capped.length} comment(s) on ticket #${params.ticketId}${warning}`, cacheHandle: entry.handle, flagged };
}
