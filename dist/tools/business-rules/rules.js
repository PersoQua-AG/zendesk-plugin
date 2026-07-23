// src/tools/business-rules/rules.ts
// M4 Rules engine: triggers, automations, SLA policies. Read (list) + create/update only —
// NO delete of any rule (PRD §N1, enforced by omission). Rule writes are admin-gated: a
// scope∩role 403 is re-mapped to an actionable ZendeskPermissionError (a plan-gated/object-
// scoped 403 keeps its Zendesk detail). Triggers and automations share one byte-identical
// schema (RuleSchema); only their collection/label differ.
import { z } from 'zod';
import { summariseScreened, makeDescribe } from '../screening.js';
import { listCbp, DEFAULT_LIST_CAP } from '../cbp-list.js';
import { createEntity, updateEntity, withAdminGuard } from '../write-helpers.js';
// Trigger/automation conditions & actions are structured config (field/operator/value).
// Numbers/operators pass through; the field-agnostic deep screen neutralizes any embedded
// free-text (an authored `value` string, a notification body) — the reason we screen these
// reads even though the top-level record is config.
const RuleConditionsSchema = z
    .object({ all: z.array(z.record(z.unknown())).nullish(), any: z.array(z.record(z.unknown())).nullish() })
    .nullish();
const RuleActionsSchema = z.array(z.record(z.unknown())).nullish();
// Triggers and automations are byte-identical over the wire — one schema, two labels.
const RuleSchema = z.object({
    id: z.number(),
    title: z.string().nullish(),
    active: z.boolean().nullish(),
    description: z.string().nullish(),
    conditions: RuleConditionsSchema,
    actions: RuleActionsSchema,
    updated_at: z.string().nullish(),
});
const describeTrigger = makeDescribe('trigger', (t) => `#${t.id} ${t.title ?? '(untitled)'}${t.active === false ? ' (inactive)' : ''}`);
const describeAutomation = makeDescribe('automation', (a) => `#${a.id} ${a.title ?? '(untitled)'}${a.active === false ? ' (inactive)' : ''}`);
export async function listTriggers(client, cache, params = {}, securityLevel = 'standard') {
    return listCbp({
        client,
        cache,
        securityLevel,
        path: '/triggers.json',
        key: 'triggers',
        schema: RuleSchema,
        describe: describeTrigger,
        handle: 'zendesk_list_triggers',
        cap: Math.min(params.maxRecords ?? DEFAULT_LIST_CAP, DEFAULT_LIST_CAP),
        pageSize: params.pageSize,
        label: (n) => `${n} trigger(s)`,
        errorLabel: '/triggers',
    });
}
export async function listAutomations(client, cache, params = {}, securityLevel = 'standard') {
    return listCbp({
        client,
        cache,
        securityLevel,
        path: '/automations.json',
        key: 'automations',
        schema: RuleSchema,
        describe: describeAutomation,
        handle: 'zendesk_list_automations',
        cap: Math.min(params.maxRecords ?? DEFAULT_LIST_CAP, DEFAULT_LIST_CAP),
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
const describeSla = makeDescribe('sla-policy', (p) => `#${p.id} ${p.title ?? '(untitled)'}`);
const SlaListSchema = z.object({ sla_policies: z.array(SlaPolicySchema) });
export async function listSlaPolicies(client, cache, params = {}, securityLevel = 'standard') {
    // /slas/policies is not CBP — it returns the full set in one response. Re-clamp the cap so an
    // oversized account (or a direct over-cap caller) cannot push an unbounded array through
    // screening/into the cache.
    const cap = Math.min(params.maxRecords ?? DEFAULT_LIST_CAP, DEFAULT_LIST_CAP);
    const raw = await client.request('/slas/policies.json');
    const parsed = SlaListSchema.safeParse(raw);
    if (!parsed.success)
        throw new Error('Unexpected /slas/policies response shape.');
    const capped = parsed.data.sla_policies.slice(0, cap);
    const screened = summariseScreened(capped, describeSla, securityLevel);
    const entry = cache.save('zendesk_list_slas', { sla_policies: screened.records });
    return {
        summary: `${screened.records.length} SLA policy(ies):\n${screened.lines.join('\n')}${screened.warning}`,
        cacheHandle: entry.handle,
        flagged: screened.flagged,
    };
}
// Register-boundary write schemas. RuleWriteFields/SlaWriteFields are derived from these
// (z.infer) so the boundary type is precise — matching M2/M3's typed field shapes — while the
// internal update tail (updateEntity) stays field-agnostic. The registrar imports these.
const conditionsWriteSchema = z
    .object({ all: z.array(z.record(z.unknown())).optional(), any: z.array(z.record(z.unknown())).optional() })
    .optional();
const actionsWriteSchema = z.array(z.record(z.unknown())).optional();
export const ruleWriteFieldsSchema = z.object({
    title: z.string().min(1).optional(),
    active: z.boolean().optional(),
    description: z.string().optional(),
    conditions: conditionsWriteSchema,
    actions: actionsWriteSchema,
});
export const slaWriteFieldsSchema = z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    position: z.number().int().nonnegative().optional(),
    filter: z.record(z.unknown()).optional(),
    policy_metrics: z.array(z.record(z.unknown())).optional(),
});
const TRIGGER_WRITE = { collection: '/triggers', key: 'trigger', resourceLabel: 'trigger', requiredFields: ['title'] };
export function createTrigger(client, cache, params, securityLevel = 'standard') {
    return createEntity(client, cache, { ...TRIGGER_WRITE, toolName: 'zendesk_create_trigger', guard: withAdminGuard }, params.fields, securityLevel);
}
export function updateTrigger(client, cache, params, securityLevel = 'standard') {
    return updateEntity(client, cache, { ...TRIGGER_WRITE, toolName: 'zendesk_update_trigger', guard: withAdminGuard }, params.id, params.fields, securityLevel);
}
const AUTOMATION_WRITE = { collection: '/automations', key: 'automation', resourceLabel: 'automation', requiredFields: ['title'] };
export function createAutomation(client, cache, params, securityLevel = 'standard') {
    return createEntity(client, cache, { ...AUTOMATION_WRITE, toolName: 'zendesk_create_automation', guard: withAdminGuard }, params.fields, securityLevel);
}
export function updateAutomation(client, cache, params, securityLevel = 'standard') {
    return updateEntity(client, cache, { ...AUTOMATION_WRITE, toolName: 'zendesk_update_automation', guard: withAdminGuard }, params.id, params.fields, securityLevel);
}
// SLA policy create also needs policy_metrics/filter to be genuinely valid; the generic guard
// enforces the common denominator (title) and Zendesk 422s on the rest — validated at the
// register boundary. Envelope key is 'sla_policy'; collection is '/slas/policies'. The label
// 'sla-policy' matches describeSla (one label everywhere).
const SLA_WRITE = { collection: '/slas/policies', key: 'sla_policy', resourceLabel: 'sla-policy', requiredFields: ['title'] };
export function createSla(client, cache, params, securityLevel = 'standard') {
    return createEntity(client, cache, { ...SLA_WRITE, toolName: 'zendesk_create_sla', guard: withAdminGuard }, params.fields, securityLevel);
}
export function updateSla(client, cache, params, securityLevel = 'standard') {
    return updateEntity(client, cache, { ...SLA_WRITE, toolName: 'zendesk_update_sla', guard: withAdminGuard }, params.id, params.fields, securityLevel);
}
