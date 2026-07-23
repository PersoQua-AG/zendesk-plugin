// src/tools/ticket-metadata.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { ZendeskPermissionError } from '../client/errors.js';

const FieldsSchema = z.object({ ticket_fields: z.array(z.object({ id: z.number(), title: z.string(), type: z.string() })) });
const FormsSchema = z.object({ ticket_forms: z.array(z.object({ id: z.number(), name: z.string() })) });

export async function listTicketFields(
  client: ZendeskHttpClient,
  cache: ResponseCache,
): Promise<{ summary: string; cacheHandle: string }> {
  const raw = await client.request<unknown>('/ticket_fields.json');
  const parsed = FieldsSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /ticket_fields response shape.');
  const entry = cache.save('zendesk_list_ticket_fields', parsed.data);
  return { summary: `Fetched ${parsed.data.ticket_fields.length} ticket field(s)`, cacheHandle: entry.handle };
}

export async function listTicketForms(
  client: ZendeskHttpClient,
  cache: ResponseCache,
): Promise<{ available: boolean; summary: string; cacheHandle: string | null }> {
  try {
    const raw = await client.request<unknown>('/ticket_forms.json');
    const parsed = FormsSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unexpected /ticket_forms response shape.');
    const entry = cache.save('zendesk_list_ticket_forms', parsed.data);
    return { available: true, summary: `Fetched ${parsed.data.ticket_forms.length} ticket form(s)`, cacheHandle: entry.handle };
  } catch (err) {
    // Ticket forms are Enterprise-only (PRD §4/§12) — degrade instead of failing the tool.
    if (err instanceof ZendeskPermissionError) {
      return { available: false, summary: 'Ticket forms are unavailable on this Zendesk plan (Enterprise-gated).', cacheHandle: null };
    }
    throw err;
  }
}
