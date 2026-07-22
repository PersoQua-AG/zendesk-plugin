// src/tools/ticket-audits.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { paginateCbp, type CbpPage } from '../client/paginator.js';
import { screenContent, type SecurityLevel } from '../security/screen.js';
import type { ReadResult } from './tickets.js';

const AuditSchema = z.object({ id: z.number(), events: z.array(z.record(z.unknown())).nullish() });
type Audit = z.infer<typeof AuditSchema>;

const AuditsPageSchema = z.object({
  audits: z.array(AuditSchema),
  meta: z.object({ has_more: z.boolean(), after_cursor: z.string().nullable() }),
  links: z.object({ next: z.string().nullable() }).nullish(),
});

export async function getTicketAudits(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { ticketId: number; maxRecords?: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const cap = params.maxRecords ?? 500;
  const fetchPage = async (cursor: string | null): Promise<CbpPage<Audit>> => {
    const parts = ['page[size]=100'];
    if (cursor) parts.push(`page[after]=${encodeURIComponent(cursor)}`);
    const raw = await client.request<unknown>(`/tickets/${params.ticketId}/audits.json?${parts.join('&')}`);
    const parsed = AuditsPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unexpected /tickets/{id}/audits response shape.');
    return { records: parsed.data.audits, meta: parsed.data.meta, links: { next: parsed.data.links?.next ?? null } };
  };

  const audits: Audit[] = [];
  for await (const batch of paginateCbp(fetchPage)) {
    audits.push(...batch);
    if (audits.length >= cap) break;
  }
  const capped = audits.slice(0, cap);
  const entry = cache.save('zendesk_get_ticket_audits', { audits: capped });

  let flagged = false;
  for (const audit of capped) {
    for (const event of audit.events ?? []) {
      const body = typeof event.body === 'string' ? event.body : null;
      if (body && screenContent(body, `audit-${audit.id}`, securityLevel).flagged) flagged = true;
    }
  }
  const warning = flagged ? ' — WARNING: injection patterns detected in audit content' : '';
  return { summary: `${capped.length} audit(s) for ticket #${params.ticketId}${warning}`, cacheHandle: entry.handle, flagged };
}
