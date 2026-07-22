// src/tools/business-rules.ts
// M4 Business Rules: views, macros, triggers, automations, SLA policies.
// Read + create/update only — NO delete of any rule (PRD §N1, enforced by omission).
// Macro apply is preview→confirm→persist (PRD §5.2). Rule writes are admin-gated: a 403
// scope∩role is re-mapped to an actionable ZendeskPermissionError. Every inbound record is
// screened at ingest by construction (titles/values fenced; structured config passes through).
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import type { SecurityLevel } from '../security/screen.js';
import { makeScreener, screenRecordDeep, summariseScreened, makeDescribe, SCREEN_WARNING } from './screening.js';
import { listCbp, DEFAULT_LIST_CAP } from './cbp-list.js';
import { ZendeskConflictError, ZendeskPermissionError } from '../client/errors.js';
import { stripUndefined } from '../util/object.js';
import type { ReadResult } from './result.js';

const ViewSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  active: z.boolean().nullish(),
  position: z.number().nullish(),
  updated_at: z.string().nullish(),
});
export type View = z.infer<typeof ViewSchema>;

// A view's untrusted free text is its title (an agent/admin authored it). `title` is in the
// ALWAYS_FENCE set, so makeDescribe's deep screen wraps it unconditionally; the line renders
// from the SAFE copy so no raw payload leaks into the summary.
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
    cap: params.maxRecords ?? DEFAULT_LIST_CAP,
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
    cap: params.maxRecords ?? DEFAULT_LIST_CAP,
    pageSize: params.pageSize,
    label: (n) => `${n} ticket(s) in view #${params.viewId}`,
    errorLabel: '/views/{id}/tickets',
  });
}
