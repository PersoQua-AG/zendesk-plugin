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
): Promise<{ summary: string; count: number }> {
  const raw = await client.request<unknown>(`/views/${params.viewId}/count.json`);
  const parsed = ViewCountSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /views/{id}/count response shape.');
  // Zendesk returns value:null (and fresh:false) while the count is still being recomputed.
  // Guard the null so a consumer never divides/indexes on an absent number.
  const value = parsed.data.view_count.value ?? 0;
  const stale = parsed.data.view_count.fresh === false ? ' (count is stale — Zendesk is recalculating)' : '';
  return { summary: `View #${params.viewId} matches ${value} ticket(s)${stale}.`, count: value };
}

const MacroSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  active: z.boolean().nullish(),
  description: z.string().nullish(),
  updated_at: z.string().nullish(),
});
type Macro = z.infer<typeof MacroSchema>;

const describeMacro = makeDescribe<Macro>('macro', (m) => `#${m.id} ${m.title ?? '(untitled)'}${m.active === false ? ' (inactive)' : ''}`);

export async function listMacros(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { pageSize?: number; maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  return listCbp<Macro>({
    client,
    cache,
    securityLevel,
    path: '/macros.json',
    key: 'macros',
    schema: MacroSchema,
    describe: describeMacro,
    handle: 'zendesk_list_macros',
    cap: params.maxRecords ?? DEFAULT_LIST_CAP,
    pageSize: params.pageSize,
    label: (n) => `${n} macro(s)`,
    errorLabel: '/macros',
  });
}

// The macro-apply result envelope: `result.ticket` is the would-be ticket payload (fields +
// the macro's comment). Kept permissive (record) since a macro can set arbitrary fields;
// screening walks it field-agnostically regardless of shape.
const MacroApplyResultSchema = z.object({ result: z.record(z.unknown()) });

export async function previewMacro(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { macroId: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const raw = await client.request<unknown>(`/macros/${params.macroId}/apply.json`);
  const parsed = MacroApplyResultSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /macros/{id}/apply response shape.');
  const { value, flagged } = screenRecordDeep(parsed.data, (key) => `macro-${params.macroId}-${key}`, makeScreener(securityLevel));
  const entry = cache.save('zendesk_preview_macro', value);
  return {
    summary: `Preview of macro #${params.macroId} on a blank ticket — no changes persisted (read-only).${flagged ? SCREEN_WARNING : ''}`,
    cacheHandle: entry.handle,
    flagged,
  };
}

export type ApplyMacroResult =
  | { status: 'preview'; summary: string; cacheHandle: string; flagged: boolean }
  | { status: 'applied'; summary: string; cacheHandle: string }
  | { status: 'conflict'; summary: string; cacheHandle: string; currentUpdatedStamp: string | null };

// Ticket-scoped preview envelope: result.ticket is the ready-to-PUT payload for this ticket.
const TicketScopedMacroSchema = z.object({ result: z.object({ ticket: z.record(z.unknown()) }) });
const ConflictTicketSchema = z.object({ ticket: z.object({ id: z.number(), status: z.string().nullish(), updated_at: z.string().nullish() }) });

export async function applyMacroToTicket(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { ticketId: number; macroId: number; confirm?: boolean; updatedStamp?: string; force?: boolean },
  securityLevel: SecurityLevel = 'standard',
): Promise<ApplyMacroResult> {
  // Preview is ALWAYS computed read-only first (GET, no mutation) — PRD §5.2 macro apply is
  // preview→confirm→persist and must never auto-fire.
  const rawPreview = await client.request<unknown>(`/tickets/${params.ticketId}/macros/${params.macroId}/apply.json`);
  const parsedPreview = TicketScopedMacroSchema.safeParse(rawPreview);
  if (!parsedPreview.success) throw new Error('Unexpected /tickets/{id}/macros/{id}/apply response shape.');
  const screener = makeScreener(securityLevel);
  const { value: safePreview, flagged } = screenRecordDeep(parsedPreview.data, (key) => `macro-apply-${params.ticketId}-${params.macroId}-${key}`, screener);

  // Phase 1 — no explicit confirmation: return the screened preview and STOP. Nothing persisted.
  if (params.confirm !== true) {
    const entry = cache.save('zendesk_apply_macro_to_ticket_preview', safePreview);
    return {
      status: 'preview',
      summary:
        `PREVIEW ONLY — macro #${params.macroId} would change ticket #${params.ticketId} (see cached result). Nothing was persisted. ` +
        `Re-invoke with confirm:true and the ticket's updatedStamp (from zendesk_get_ticket) to apply, or force:true to overwrite without a concurrency check.${flagged ? SCREEN_WARNING : ''}`,
      cacheHandle: entry.handle,
      flagged,
    };
  }

  // Phase 2 — explicit confirmation. Reuse the ticket safe_update contract (PRD §5.2): require
  // the last-known updatedStamp for optimistic concurrency, or an explicit force override.
  if (!params.updatedStamp && !params.force) {
    throw new Error(
      'Refusing to apply macro without an updatedStamp: pass the updatedStamp from a prior zendesk_get_ticket read to enable safe optimistic-concurrency (recommended), or set force:true to deliberately overwrite without a concurrency check.',
    );
  }
  // The preview's result.ticket is the ready-to-PUT payload (macro fields + comment).
  const ticketBody: Record<string, unknown> = { ...parsedPreview.data.result.ticket };
  if (params.updatedStamp) {
    ticketBody.safe_update = true;
    ticketBody.updated_stamp = params.updatedStamp;
  }
  try {
    const rawPut = await client.request<unknown>(`/tickets/${params.ticketId}.json`, {
      method: 'PUT',
      body: JSON.stringify({ ticket: ticketBody }),
    });
    const { value: safe } = screenRecordDeep(rawPut, (key) => `macro-applied-${params.ticketId}-${key}`, screener);
    const entry = cache.save('zendesk_apply_macro_to_ticket', safe);
    return { status: 'applied', summary: `Applied macro #${params.macroId} to ticket #${params.ticketId}.`, cacheHandle: entry.handle };
  } catch (err) {
    if (!(err instanceof ZendeskConflictError)) throw err;
    const current = await client.request<unknown>(`/tickets/${params.ticketId}.json`);
    const parsed = ConflictTicketSchema.safeParse(current);
    if (!parsed.success) throw new Error('Conflict re-fetch returned a malformed /tickets/{id} response.');
    const { value: safe } = screenRecordDeep(parsed.data, (key) => `macro-conflict-${params.ticketId}-${key}`, screener);
    const entry = cache.save('zendesk_apply_macro_to_ticket_conflict', safe);
    return {
      status: 'conflict',
      summary: `Conflict: ticket #${params.ticketId} changed since the updatedStamp you passed (current status: ${parsed.data.ticket.status ?? 'unknown'}). Re-read the ticket, review, and confirm before re-applying.`,
      cacheHandle: entry.handle,
      currentUpdatedStamp: parsed.data.ticket.updated_at ?? null,
    };
  }
}

// Trigger/automation conditions & actions are structured config (field/operator/value).
// Numbers/operators pass through; the field-agnostic deep screen neutralizes any embedded
// free-text (an authored `value` string, a notification body) — the reason we screen these
// reads even though the top-level record is config.
const RuleConditionsSchema = z
  .object({ all: z.array(z.record(z.unknown())).nullish(), any: z.array(z.record(z.unknown())).nullish() })
  .nullish();
const RuleActionsSchema = z.array(z.record(z.unknown())).nullish();

const TriggerSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  active: z.boolean().nullish(),
  description: z.string().nullish(),
  conditions: RuleConditionsSchema,
  actions: RuleActionsSchema,
  updated_at: z.string().nullish(),
});
type Trigger = z.infer<typeof TriggerSchema>;

const describeTrigger = makeDescribe<Trigger>('trigger', (t) => `#${t.id} ${t.title ?? '(untitled)'}${t.active === false ? ' (inactive)' : ''}`);

export async function listTriggers(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { pageSize?: number; maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  return listCbp<Trigger>({
    client,
    cache,
    securityLevel,
    path: '/triggers.json',
    key: 'triggers',
    schema: TriggerSchema,
    describe: describeTrigger,
    handle: 'zendesk_list_triggers',
    cap: params.maxRecords ?? DEFAULT_LIST_CAP,
    pageSize: params.pageSize,
    label: (n) => `${n} trigger(s)`,
    errorLabel: '/triggers',
  });
}

const AutomationSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  active: z.boolean().nullish(),
  description: z.string().nullish(),
  conditions: RuleConditionsSchema,
  actions: RuleActionsSchema,
  updated_at: z.string().nullish(),
});
type Automation = z.infer<typeof AutomationSchema>;

const describeAutomation = makeDescribe<Automation>('automation', (a) => `#${a.id} ${a.title ?? '(untitled)'}${a.active === false ? ' (inactive)' : ''}`);

export async function listAutomations(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { pageSize?: number; maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  return listCbp<Automation>({
    client,
    cache,
    securityLevel,
    path: '/automations.json',
    key: 'automations',
    schema: AutomationSchema,
    describe: describeAutomation,
    handle: 'zendesk_list_automations',
    cap: params.maxRecords ?? DEFAULT_LIST_CAP,
    pageSize: params.pageSize,
    label: (n) => `${n} automation(s)`,
    errorLabel: '/automations',
  });
}

const SlaPolicySchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  position: z.number().nullish(),
  filter: z.record(z.unknown()).nullish(),
  policy_metrics: z.array(z.record(z.unknown())).nullish(),
});
type SlaPolicy = z.infer<typeof SlaPolicySchema>;

const describeSla = makeDescribe<SlaPolicy>('sla-policy', (p) => `#${p.id} ${p.title ?? '(untitled)'}`);

const SlaListSchema = z.object({ sla_policies: z.array(SlaPolicySchema) });

export async function listSlaPolicies(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  // /slas/policies is not CBP — it returns the full set in one response. Cap defensively so an
  // oversized account cannot push an unbounded array through screening/into the cache.
  const cap = params.maxRecords ?? DEFAULT_LIST_CAP;
  const raw = await client.request<unknown>('/slas/policies.json');
  const parsed = SlaListSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /slas/policies response shape.');
  const capped = parsed.data.sla_policies.slice(0, cap);
  const screened = summariseScreened(capped, describeSla, securityLevel);
  const entry = cache.save('zendesk_list_slas', { sla_policies: screened.records });
  return {
    summary: `${screened.records.length} SLA policy(ies):\n${screened.lines.join('\n')}${screened.warning}`,
    cacheHandle: entry.handle,
    flagged: screened.flagged,
  };
}

// A user-authored rule write body: title plus structured/optional config. Kept as an open
// record (values are structured JSON validated at the register boundary) — no `any`.
export type RuleWriteFields = Record<string, unknown>;

interface RuleWriteConfig {
  collection: string; // e.g. '/triggers'
  key: string; // envelope key, e.g. 'trigger'
  toolName: string; // cache tool name, e.g. 'zendesk_create_trigger'
  resourceLabel: string; // human label, e.g. 'trigger'
}

// Business-rules writes require an admin role. The base client maps a 403 to a generic
// ZendeskPermissionError; re-map it to an actionable, resource-specific message. A write
// cannot degrade to empty (unlike the M2 ticket-forms read), so it surfaces the typed error.
async function withAdminGuard<T>(action: string, thunk: () => Promise<T>): Promise<T> {
  try {
    return await thunk();
  } catch (err) {
    if (err instanceof ZendeskPermissionError) {
      throw new ZendeskPermissionError(
        `${action} requires an admin role — your token's scope ∩ role is insufficient. Re-authorize with an admin account or ask an admin to make this change.`,
      );
    }
    throw err;
  }
}

const RuleEnvelopeSchema = z.record(z.unknown());
const RuleRecordSchema = z.object({ id: z.number() }).passthrough();

async function createRule(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  config: RuleWriteConfig,
  fields: RuleWriteFields,
  securityLevel: SecurityLevel,
): Promise<{ summary: string; cacheHandle: string }> {
  const title = fields.title;
  if (typeof title !== 'string' || title.trim() === '') throw new Error(`create_${config.resourceLabel} requires a title.`);
  const body = stripUndefined(fields);
  const raw = await withAdminGuard(`Creating a ${config.resourceLabel}`, () =>
    client.request<unknown>(`${config.collection}.json`, { method: 'POST', body: JSON.stringify({ [config.key]: body }) }),
  );
  const parsed = RuleEnvelopeSchema.safeParse(raw);
  const record = parsed.success ? RuleRecordSchema.safeParse(parsed.data[config.key]) : null;
  if (!record || !record.success) throw new Error(`Unexpected ${config.collection} create response shape.`);
  const { value: safe, flagged } = screenRecordDeep(parsed.data, (key) => `${config.toolName}-${record.data.id}-${key}`, makeScreener(securityLevel));
  const entry = cache.save(config.toolName, safe);
  return { summary: `Created ${config.resourceLabel} #${record.data.id}${flagged ? SCREEN_WARNING : ''}`, cacheHandle: entry.handle };
}

async function updateRule(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  config: RuleWriteConfig,
  id: number,
  fields: RuleWriteFields,
  securityLevel: SecurityLevel,
): Promise<{ summary: string; cacheHandle: string }> {
  // stripUndefined so a payload like {title: undefined} — which JSON.stringify would drop to
  // {} — cannot slip past this guard and fire an empty update.
  const body = stripUndefined(fields);
  if (Object.keys(body).length === 0) throw new Error(`update_${config.resourceLabel} requires at least one field to change.`);
  const raw = await withAdminGuard(`Updating a ${config.resourceLabel}`, () =>
    client.request<unknown>(`${config.collection}/${id}.json`, { method: 'PUT', body: JSON.stringify({ [config.key]: body }) }),
  );
  const parsed = RuleEnvelopeSchema.safeParse(raw);
  const record = parsed.success ? RuleRecordSchema.safeParse(parsed.data[config.key]) : null;
  if (!record || !record.success) throw new Error(`Unexpected ${config.collection} update response shape.`);
  const { value: safe, flagged } = screenRecordDeep(parsed.data, (key) => `${config.toolName}-${id}-${key}`, makeScreener(securityLevel));
  const entry = cache.save(config.toolName, safe);
  return { summary: `Updated ${config.resourceLabel} #${id}${flagged ? SCREEN_WARNING : ''}`, cacheHandle: entry.handle };
}

const TRIGGER_WRITE: Omit<RuleWriteConfig, 'toolName'> = { collection: '/triggers', key: 'trigger', resourceLabel: 'trigger' };

export function createTrigger(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { fields: RuleWriteFields },
  securityLevel: SecurityLevel = 'standard',
): Promise<{ summary: string; cacheHandle: string }> {
  return createRule(client, cache, { ...TRIGGER_WRITE, toolName: 'zendesk_create_trigger' }, params.fields, securityLevel);
}

export function updateTrigger(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { id: number; fields: RuleWriteFields },
  securityLevel: SecurityLevel = 'standard',
): Promise<{ summary: string; cacheHandle: string }> {
  return updateRule(client, cache, { ...TRIGGER_WRITE, toolName: 'zendesk_update_trigger' }, params.id, params.fields, securityLevel);
}
