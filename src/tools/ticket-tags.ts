// src/tools/ticket-tags.ts
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';

export async function addTicketTags(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { ticketId: number; tags: string[]; replace?: boolean },
): Promise<{ summary: string; cacheHandle: string }> {
  if (params.tags.length === 0) throw new Error('At least one tag is required.');
  // Append (POST) is the safe default; PUT replaces the whole set — data-loss trap (PRD §5.2).
  const method = params.replace ? 'PUT' : 'POST';
  const raw = await client.request<{ tags: string[] }>(`/tickets/${params.ticketId}/tags.json`, {
    method,
    body: JSON.stringify({ tags: params.tags }),
  });
  const entry = cache.save('zendesk_add_ticket_tags', raw);
  const verb = params.replace ? 'Replaced' : 'Appended';
  return { summary: `${verb} tags on ticket #${params.ticketId}: ${raw.tags.join(', ')}`, cacheHandle: entry.handle };
}
