// src/register/users-orgs.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { okWithHandle } from '../tools/result.js';
import { searchUsers, getUser, upsertUser, updateUser, listUserIdentities } from '../tools/users.js';
import { listOrgs, getOrg, upsertOrg, updateOrg, listOrgMemberships } from '../tools/orgs.js';
import { listGroups, listGroupMemberships } from '../tools/groups.js';
import type { ToolContext } from './context.js';

// Shared write-field validation, reused by upsert and update so both paths validate
// symmetrically (mirrors the ticketUpdateFieldsSchema pattern in register/tickets.ts).
const userWriteFieldsSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  external_id: z.string().optional(),
  role: z.enum(['end-user', 'agent', 'admin']).optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
  details: z.string().optional(),
  organization_id: z.number().int().positive().optional(),
  verified: z.boolean().optional(),
});

const orgWriteFieldsSchema = z.object({
  name: z.string().min(1).optional(),
  notes: z.string().optional(),
  details: z.string().optional(),
  external_id: z.string().optional(),
  group_id: z.number().int().positive().optional(),
  tags: z.array(z.string()).optional(),
});

export function registerUserOrgTools(server: McpServer, ctx: ToolContext): void {
  const { httpClient, cache, securityLevel } = ctx;

  server.registerTool(
    'zendesk_search_users',
    {
      description: 'Search users by a Zendesk user-search query (e.g. "role:agent", an email, or a name). Screened; returns a summary + cache handle.',
      inputSchema: { query: z.string().min(1), maxRecords: z.number().int().positive().max(1000).optional() },
    },
    async (args) => okWithHandle(await searchUsers(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_get_user',
    { description: 'Get one user by id (screened).', inputSchema: { userId: z.number().int().positive() } },
    async ({ userId }) => okWithHandle(await getUser(httpClient, cache, { userId }, securityLevel)),
  );

  server.registerTool(
    'zendesk_upsert_user',
    {
      description: 'Create or update a user idempotently (matched by external_id/email). Requires a name plus an email or external_id. Confirm the change in-conversation before calling.',
      inputSchema: userWriteFieldsSchema.shape,
    },
    async (fields) => okWithHandle(await upsertUser(httpClient, cache, { fields }, securityLevel)),
  );

  server.registerTool(
    'zendesk_update_user',
    {
      description: 'Update an existing user by id. Confirm the change in-conversation before calling.',
      inputSchema: { userId: z.number().int().positive(), fields: userWriteFieldsSchema },
    },
    async ({ userId, fields }) => okWithHandle(await updateUser(httpClient, cache, { userId, fields }, securityLevel)),
  );

  server.registerTool(
    'zendesk_list_user_identities',
    { description: 'List a user’s identities (email/phone), cursor-paginated and screened.', inputSchema: { userId: z.number().int().positive(), maxRecords: z.number().int().positive().optional() } },
    async (args) => okWithHandle(await listUserIdentities(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_list_orgs',
    {
      description: 'List organizations (cursor-paginated, screened).',
      inputSchema: { pageSize: z.number().int().positive().max(100).optional(), maxRecords: z.number().int().positive().optional() },
    },
    async (args) => okWithHandle(await listOrgs(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_get_org',
    { description: 'Get one organization by id (screened).', inputSchema: { orgId: z.number().int().positive() } },
    async ({ orgId }) => okWithHandle(await getOrg(httpClient, cache, { orgId }, securityLevel)),
  );

  server.registerTool(
    'zendesk_upsert_org',
    {
      description: 'Create or update an organization idempotently (matched by name/external_id). Requires a name. Confirm the change in-conversation before calling.',
      inputSchema: orgWriteFieldsSchema.shape,
    },
    async (fields) => okWithHandle(await upsertOrg(httpClient, cache, { fields }, securityLevel)),
  );

  server.registerTool(
    'zendesk_update_org',
    {
      description: 'Update an existing organization by id. Confirm the change in-conversation before calling.',
      inputSchema: { orgId: z.number().int().positive(), fields: orgWriteFieldsSchema },
    },
    async ({ orgId, fields }) => okWithHandle(await updateOrg(httpClient, cache, { orgId, fields }, securityLevel)),
  );

  server.registerTool(
    'zendesk_list_org_memberships',
    { description: 'List organization memberships (user↔org links), cursor-paginated.', inputSchema: { maxRecords: z.number().int().positive().optional() } },
    async (args) => okWithHandle(await listOrgMemberships(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_list_groups',
    { description: 'List agent groups (cursor-paginated, screened).', inputSchema: { maxRecords: z.number().int().positive().optional() } },
    async (args) => okWithHandle(await listGroups(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_list_group_memberships',
    { description: 'List group memberships (user↔group links), cursor-paginated.', inputSchema: { maxRecords: z.number().int().positive().optional() } },
    async (args) => okWithHandle(await listGroupMemberships(httpClient, cache, args, securityLevel)),
  );
}
