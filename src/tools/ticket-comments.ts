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
