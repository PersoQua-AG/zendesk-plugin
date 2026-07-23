import { z } from 'zod';
import { okWithHandle, toText } from '../tools/result.js';
import { listViews, getView, executeView, viewCount } from '../tools/business-rules/views.js';
import { listMacros, previewMacro, applyMacroToTicket } from '../tools/business-rules/macros.js';
import { listTriggers, listAutomations, listSlaPolicies, createTrigger, updateTrigger, createAutomation, updateAutomation, createSla, updateSla, ruleWriteFieldsSchema, slaWriteFieldsSchema, } from '../tools/business-rules/rules.js';
import { DEFAULT_LIST_CAP, MAX_PAGE_SIZE } from '../tools/cbp-list.js';
const pageSizeSchema = z.number().int().positive().max(MAX_PAGE_SIZE).optional();
const listMaxRecordsSchema = z.number().int().positive().max(DEFAULT_LIST_CAP).optional();
const idSchema = z.number().int().positive();
export function registerBusinessRulesTools(server, ctx) {
    const { httpClient, cache, securityLevel } = ctx;
    server.registerTool('zendesk_list_views', { description: 'List views (cursor-paginated, screened).', inputSchema: { pageSize: pageSizeSchema, maxRecords: listMaxRecordsSchema } }, async (args) => okWithHandle(await listViews(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_get_view', { description: 'Get one view by id (screened).', inputSchema: { viewId: z.number().int().positive() } }, async ({ viewId }) => okWithHandle(await getView(httpClient, cache, { viewId }, securityLevel)));
    server.registerTool('zendesk_execute_view', {
        description: 'Execute a view: list the tickets it currently matches (cursor-paginated, screened).',
        inputSchema: { viewId: z.number().int().positive(), pageSize: pageSizeSchema, maxRecords: listMaxRecordsSchema },
    }, async (args) => okWithHandle(await executeView(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_view_count', { description: 'Return the number of tickets a view currently matches.', inputSchema: { viewId: z.number().int().positive() } }, async ({ viewId }) => toText((await viewCount(httpClient, { viewId })).summary));
    server.registerTool('zendesk_list_macros', { description: 'List macros (cursor-paginated, screened).', inputSchema: { pageSize: pageSizeSchema, maxRecords: listMaxRecordsSchema } }, async (args) => okWithHandle(await listMacros(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_preview_macro', { description: 'Preview a macro’s effect on a blank ticket. READ-ONLY — nothing is persisted.', inputSchema: { macroId: z.number().int().positive() } }, async ({ macroId }) => okWithHandle(await previewMacro(httpClient, cache, { macroId }, securityLevel)));
    server.registerTool('zendesk_apply_macro_to_ticket', {
        description: 'Apply a macro to a ticket. Without confirm:true this PREVIEWS the change only (read-only). With confirm:true it persists via a follow-up PUT — pass the ticket’s updatedStamp (from zendesk_get_ticket) for safe_update optimistic concurrency (409 → conflict; do not overwrite without confirming), or force:true to overwrite without a concurrency check.',
        inputSchema: {
            ticketId: z.number().int().positive(),
            macroId: z.number().int().positive(),
            confirm: z.boolean().optional(),
            updatedStamp: z.string().optional(),
            force: z.boolean().optional(),
        },
    }, async (args) => {
        const r = await applyMacroToTicket(httpClient, cache, args, securityLevel);
        return toText(`${r.status.toUpperCase()}: ${r.summary}\n(cache: ${r.cacheHandle})`);
    });
    server.registerTool('zendesk_list_triggers', { description: 'List triggers (cursor-paginated, screened).', inputSchema: { pageSize: pageSizeSchema, maxRecords: listMaxRecordsSchema } }, async (args) => okWithHandle(await listTriggers(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_list_automations', { description: 'List automations (cursor-paginated, screened).', inputSchema: { pageSize: pageSizeSchema, maxRecords: listMaxRecordsSchema } }, async (args) => okWithHandle(await listAutomations(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_list_slas', { description: 'List SLA policies (screened).', inputSchema: { maxRecords: listMaxRecordsSchema } }, async (args) => okWithHandle(await listSlaPolicies(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_create_trigger', {
        description: 'Create a trigger (admin only). Requires a title. Confirm the change in-conversation before calling.',
        inputSchema: ruleWriteFieldsSchema.shape,
    }, async (fields) => okWithHandle(await createTrigger(httpClient, cache, { fields }, securityLevel)));
    server.registerTool('zendesk_update_trigger', {
        // Flat args with a top-level `id` — same shape as create (which is flat) so an LLM caller
        // uses one consistent field layout across create and update.
        description: 'Update a trigger by id (admin only). Confirm the change in-conversation before calling.',
        inputSchema: { id: idSchema, ...ruleWriteFieldsSchema.shape },
    }, async ({ id, ...fields }) => okWithHandle(await updateTrigger(httpClient, cache, { id, fields }, securityLevel)));
    server.registerTool('zendesk_create_automation', {
        description: 'Create an automation (admin only). Requires a title. Confirm the change in-conversation before calling.',
        inputSchema: ruleWriteFieldsSchema.shape,
    }, async (fields) => okWithHandle(await createAutomation(httpClient, cache, { fields }, securityLevel)));
    server.registerTool('zendesk_update_automation', {
        description: 'Update an automation by id (admin only). Confirm the change in-conversation before calling.',
        inputSchema: { id: idSchema, ...ruleWriteFieldsSchema.shape },
    }, async ({ id, ...fields }) => okWithHandle(await updateAutomation(httpClient, cache, { id, fields }, securityLevel)));
    server.registerTool('zendesk_create_sla', {
        description: 'Create an SLA policy (admin only). Requires a title (plus policy_metrics for a valid policy). Confirm the change in-conversation before calling.',
        inputSchema: slaWriteFieldsSchema.shape,
    }, async (fields) => okWithHandle(await createSla(httpClient, cache, { fields }, securityLevel)));
    server.registerTool('zendesk_update_sla', {
        description: 'Update an SLA policy by id (admin only). Confirm the change in-conversation before calling.',
        inputSchema: { id: idSchema, ...slaWriteFieldsSchema.shape },
    }, async ({ id, ...fields }) => okWithHandle(await updateSla(httpClient, cache, { id, fields }, securityLevel)));
}
