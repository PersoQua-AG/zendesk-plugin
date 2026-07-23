// src/tools/ticket-tags.ts
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import type { SecurityLevel } from '../security/screen.js';
import { makeScreener, screenRecordDeep, SCREEN_WARNING } from './screening.js';

export async function addTicketTags(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { ticketId: number; tags: string[]; replace?: boolean },
  securityLevel: SecurityLevel = 'standard',
): Promise<{ summary: string; cacheHandle: string }> {
  if (params.tags.length === 0) throw new Error('At least one tag is required.');
  // Append (POST) is the safe default; PUT replaces the whole set — data-loss trap (PRD §5.2).
  const method = params.replace ? 'PUT' : 'POST';
  const raw = await client.request<{ tags: string[] }>(`/tickets/${params.ticketId}/tags.json`, {
    method,
    body: JSON.stringify({ tags: params.tags }),
  });
  // Defense in depth: the tags echoed back are inbound content — screen at ingest so the
  // cached payload is safe at rest.
  const { value: safe, flagged } = screenRecordDeep(raw, (key) => `ticket-tags-${params.ticketId}-${key}`, makeScreener(securityLevel));
  const entry = cache.save('zendesk_add_ticket_tags', safe);
  const verb = params.replace ? 'Replaced' : 'Appended';
  const tags = (safe as { tags: string[] }).tags;
  return { summary: `${verb} tags on ticket #${params.ticketId}: ${tags.join(', ')}${flagged ? SCREEN_WARNING : ''}`, cacheHandle: entry.handle };
}
