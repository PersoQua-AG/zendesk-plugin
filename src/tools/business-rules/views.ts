// src/tools/business-rules/views.ts
// M4 Views: read-only. List/get views, execute a view (its matching tickets), and count.
// Every inbound record is screened at ingest by construction (titles fenced; the rest passes
// through the field-agnostic deep screen).
import { z } from 'zod';
import type { ZendeskHttpClient } from '../../client/http-client.js';
import type { ResponseCache } from '../../client/cache.js';
import type { SecurityLevel } from '../../security/screen.js';
import { makeScreener, screenRecordDeep, makeDescribe, SCREEN_WARNING } from '../screening.js';
import { listCbp, DEFAULT_LIST_CAP } from '../cbp-list.js';
import type { ReadResult } from '../result.js';

const ViewSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  active: z.boolean().nullish(),
  position: z.number().nullish(),
  updated_at: z.string().nullish(),
});
export type View = z.infer<typeof ViewSchema>;

// A view's untrusted free text is its title. `title` is in the ALWAYS_FENCE set, so the deep
// screen wraps it unconditionally; the line renders from the SAFE copy so no raw payload leaks.
const describeView = makeDescribe<View>('view', (v) => `#${v.id} ${v.title ?? '(untitled)'}${v.active === false ? ' (inactive)' : ''}`);

export async function listViews(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { pageSize?: number; maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  return listCbp<View>({
    client,
    cache,
    securityLevel,
    path: '/views.json',
    key: 'views',
    schema: ViewSchema,
    describe: describeView,
    handle: 'zendesk_list_views',
    // Re-clamp to the cap: the register schema ceilings a direct/non-MCP caller, but the tool
    // must not itself accept an over-cap maxRecords (defense in depth).
    cap: Math.min(params.maxRecords ?? DEFAULT_LIST_CAP, DEFAULT_LIST_CAP),
    pageSize: params.pageSize,
    label: (n) => `${n} view(s)`,
    errorLabel: '/views',
  });
}

const SingleViewSchema = z.object({ view: ViewSchema });

export async function getView(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { viewId: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const raw = await client.request<unknown>(`/views/${params.viewId}.json`);
  const parsed = SingleViewSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /views/{id} response shape.');
  const { value, flagged } = screenRecordDeep(parsed.data, (key) => `view-${params.viewId}-${key}`, makeScreener(securityLevel));
  const safe = value as { view: View };
  const entry = cache.save('zendesk_get_view', safe);
  return {
    summary: `View #${safe.view.id} ${safe.view.title ?? '(untitled)'}${flagged ? SCREEN_WARNING : ''}`,
    cacheHandle: entry.handle,
    flagged,
  };
}

const ViewTicketSchema = z.object({
  id: z.number(),
  subject: z.string().nullish(),
  description: z.string().nullish(),
  status: z.string().nullish(),
  priority: z.string().nullish(),
  updated_at: z.string().nullish(),
});
type ViewTicket = z.infer<typeof ViewTicketSchema>;

const describeViewTicket = makeDescribe<ViewTicket>('view-ticket', (t) => `#${t.id} [${t.status ?? 'unknown'}] ${t.subject ?? '(no subject)'}`);

export async function executeView(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { viewId: number; pageSize?: number; maxRecords?: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  return listCbp<ViewTicket>({
    client,
    cache,
    securityLevel,
    path: `/views/${params.viewId}/tickets.json`,
    key: 'tickets',
    schema: ViewTicketSchema,
    describe: describeViewTicket,
    handle: 'zendesk_execute_view',
    cap: Math.min(params.maxRecords ?? DEFAULT_LIST_CAP, DEFAULT_LIST_CAP),
    pageSize: params.pageSize,
    label: (n) => `${n} ticket(s) in view #${params.viewId}`,
    errorLabel: '/views/{id}/tickets',
  });
}

const ViewCountSchema = z.object({
  view_count: z.object({
    view_id: z.number().nullish(),
    value: z.number().nullable(),
    pretty: z.string().nullish(),
    fresh: z.boolean().nullish(),
  }),
});

export async function viewCount(
  client: ZendeskHttpClient,
  params: { viewId: number },
): Promise<{ summary: string }> {
  const raw = await client.request<unknown>(`/views/${params.viewId}/count.json`);
  const parsed = ViewCountSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /views/{id}/count response shape.');
  const vc = parsed.data.view_count;
  // Zendesk returns value:null (with fresh:false) while a count is still being recomputed. That
  // is NOT a true 0 — report it as unknown/recalculating so a consumer never treats it as zero.
  if (vc.value == null) {
    return {
      summary: `View #${params.viewId} ticket count is currently unknown — Zendesk is recalculating it (this is not a true 0; try again shortly).`,
    };
  }
  const stale = vc.fresh === false ? ' (count is stale — Zendesk is recalculating)' : '';
  return { summary: `View #${params.viewId} matches ${vc.value} ticket(s)${stale}.` };
}
