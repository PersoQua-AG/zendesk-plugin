// src/register/business-rules.ts — views, macros, triggers, automations, SLA policies.
// Read + create/update only (no rule delete). Macro apply is preview→confirm→persist.
// Rule writes are admin-gated (403 → actionable ZendeskPermissionError inside the tool).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { okWithHandle, toText } from '../tools/result.js';
import {
  listViews,
  getView,
  executeView,
  viewCount,
  listMacros,
  previewMacro,
  applyMacroToTicket,
  listTriggers,
  listAutomations,
  listSlaPolicies,
  createTrigger,
  updateTrigger,
  createAutomation,
  updateAutomation,
  createSla,
  updateSla,
} from '../tools/business-rules.js';
import { DEFAULT_LIST_CAP, MAX_PAGE_SIZE } from '../tools/cbp-list.js';
import type { ToolContext } from './context.js';

const pageSizeSchema = z.number().int().positive().max(MAX_PAGE_SIZE).optional();
const listMaxRecordsSchema = z.number().int().positive().max(DEFAULT_LIST_CAP).optional();

// Rule conditions/actions are structured JSON config. Validate the envelope shape (arrays of
// objects) without over-constraining Zendesk's evolving field vocabulary.
const conditionsSchema = z
  .object({ all: z.array(z.record(z.unknown())).optional(), any: z.array(z.record(z.unknown())).optional() })
  .optional();
const actionsSchema = z.array(z.record(z.unknown())).optional();

// Shared write-field schemas: title optional here (the tool enforces it on create), so upsert
// and update validate symmetrically — mirrors the M3 directory registrar pattern.
const ruleWriteFieldsSchema = z.object({
  title: z.string().min(1).optional(),
  active: z.boolean().optional(),
  description: z.string().optional(),
  conditions: conditionsSchema,
  actions: actionsSchema,
});

const slaWriteFieldsSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  position: z.number().int().nonnegative().optional(),
  filter: z.record(z.unknown()).optional(),
  policy_metrics: z.array(z.record(z.unknown())).optional(),
});

export function registerBusinessRulesTools(server: McpServer, ctx: ToolContext): void {
  const { httpClient, cache, securityLevel } = ctx;

  server.registerTool(
    'zendesk_list_views',
    { description: 'List views (cursor-paginated, screened).', inputSchema: { pageSize: pageSizeSchema, maxRecords: listMaxRecordsSchema } },
    async (args) => okWithHandle(await listViews(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_get_view',
    { description: 'Get one view by id (screened).', inputSchema: { viewId: z.number().int().positive() } },
    async ({ viewId }) => okWithHandle(await getView(httpClient, cache, { viewId }, securityLevel)),
  );

  server.registerTool(
    'zendesk_execute_view',
    {
      description: 'Execute a view: list the tickets it currently matches (cursor-paginated, screened).',
      inputSchema: { viewId: z.number().int().positive(), pageSize: pageSizeSchema, maxRecords: listMaxRecordsSchema },
    },
    async (args) => okWithHandle(await executeView(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_view_count',
    { description: 'Return the number of tickets a view currently matches.', inputSchema: { viewId: z.number().int().positive() } },
    async ({ viewId }) => toText((await viewCount(httpClient, { viewId })).summary),
  );

  server.registerTool(
    'zendesk_list_macros',
    { description: 'List macros (cursor-paginated, screened).', inputSchema: { pageSize: pageSizeSchema, maxRecords: listMaxRecordsSchema } },
    async (args) => okWithHandle(await listMacros(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_preview_macro',
    { description: 'Preview a macro’s effect on a blank ticket. READ-ONLY — nothing is persisted.', inputSchema: { macroId: z.number().int().positive() } },
    async ({ macroId }) => okWithHandle(await previewMacro(httpClient, cache, { macroId }, securityLevel)),
  );

  server.registerTool(
    'zendesk_apply_macro_to_ticket',
    {
      description:
        'Apply a macro to a ticket. Without confirm:true this PREVIEWS the change only (read-only). With confirm:true it persists via a follow-up PUT — pass the ticket’s updatedStamp (from zendesk_get_ticket) for safe_update optimistic concurrency (409 → conflict; do not overwrite without confirming), or force:true to overwrite without a concurrency check.',
      inputSchema: {
        ticketId: z.number().int().positive(),
        macroId: z.number().int().positive(),
        confirm: z.boolean().optional(),
        updatedStamp: z.string().optional(),
        force: z.boolean().optional(),
      },
    },
    async (args) => {
      const r = await applyMacroToTicket(httpClient, cache, args, securityLevel);
      return toText(`${r.status.toUpperCase()}: ${r.summary}\n(cache: ${r.cacheHandle})`);
    },
  );

  server.registerTool(
    'zendesk_list_triggers',
    { description: 'List triggers (cursor-paginated, screened).', inputSchema: { pageSize: pageSizeSchema, maxRecords: listMaxRecordsSchema } },
    async (args) => okWithHandle(await listTriggers(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_list_automations',
    { description: 'List automations (cursor-paginated, screened).', inputSchema: { pageSize: pageSizeSchema, maxRecords: listMaxRecordsSchema } },
    async (args) => okWithHandle(await listAutomations(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_list_slas',
    { description: 'List SLA policies (screened).', inputSchema: { maxRecords: listMaxRecordsSchema } },
    async (args) => okWithHandle(await listSlaPolicies(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_create_trigger',
    {
      description: 'Create a trigger (admin only). Requires a title. Confirm the change in-conversation before calling.',
      inputSchema: ruleWriteFieldsSchema.shape,
    },
    async (fields) => okWithHandle(await createTrigger(httpClient, cache, { fields }, securityLevel)),
  );

  server.registerTool(
    'zendesk_update_trigger',
    {
      description: 'Update a trigger by id (admin only). Confirm the change in-conversation before calling.',
      inputSchema: { id: z.number().int().positive(), fields: ruleWriteFieldsSchema },
    },
    async ({ id, fields }) => okWithHandle(await updateTrigger(httpClient, cache, { id, fields }, securityLevel)),
  );

  server.registerTool(
    'zendesk_create_automation',
    {
      description: 'Create an automation (admin only). Requires a title. Confirm the change in-conversation before calling.',
      inputSchema: ruleWriteFieldsSchema.shape,
    },
    async (fields) => okWithHandle(await createAutomation(httpClient, cache, { fields }, securityLevel)),
  );

  server.registerTool(
    'zendesk_update_automation',
    {
      description: 'Update an automation by id (admin only). Confirm the change in-conversation before calling.',
      inputSchema: { id: z.number().int().positive(), fields: ruleWriteFieldsSchema },
    },
    async ({ id, fields }) => okWithHandle(await updateAutomation(httpClient, cache, { id, fields }, securityLevel)),
  );

  server.registerTool(
    'zendesk_create_sla',
    {
      description: 'Create an SLA policy (admin only). Requires a title (plus policy_metrics for a valid policy). Confirm the change in-conversation before calling.',
      inputSchema: slaWriteFieldsSchema.shape,
    },
    async (fields) => okWithHandle(await createSla(httpClient, cache, { fields }, securityLevel)),
  );

  server.registerTool(
    'zendesk_update_sla',
    {
      description: 'Update an SLA policy by id (admin only). Confirm the change in-conversation before calling.',
      inputSchema: { id: z.number().int().positive(), fields: slaWriteFieldsSchema },
    },
    async ({ id, fields }) => okWithHandle(await updateSla(httpClient, cache, { id, fields }, securityLevel)),
  );
}
