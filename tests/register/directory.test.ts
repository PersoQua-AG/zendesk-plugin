// tests/register/directory.test.ts
// The directory list tools must enforce a maxRecords ceiling at the schema boundary so a
// caller cannot request an unbounded count (QA-MAJOR). Capture each tool's inputSchema via a
// stub server and assert the ceiling.
import { describe, it, expect, vi } from 'vitest';
import type { z } from 'zod';
import { registerDirectoryTools } from '../../src/register/directory.js';
import { SEARCH_HARD_CAP } from '../../src/tools/search.js';
import { DEFAULT_LIST_CAP, DEFAULT_MEMBERSHIP_CAP } from '../../src/tools/cbp-list.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../../src/register/context.js';

type InputSchema = Record<string, z.ZodTypeAny>;

function registeredSchemas(): Map<string, InputSchema> {
  const tools = new Map<string, InputSchema>();
  const server = {
    registerTool: (name: string, def: { inputSchema: InputSchema }) => tools.set(name, def.inputSchema),
  } as unknown as McpServer;
  const ctx = {
    httpClient: {},
    cache: {},
    securityLevel: 'standard',
    markdownDefault: true,
  } as unknown as ToolContext;
  registerDirectoryTools(server, ctx);
  return tools;
}

const CASES: Array<[string, number]> = [
  ['zendesk_search_users', SEARCH_HARD_CAP],
  ['zendesk_list_user_identities', DEFAULT_LIST_CAP],
  ['zendesk_list_orgs', DEFAULT_LIST_CAP],
  ['zendesk_list_org_memberships', DEFAULT_MEMBERSHIP_CAP],
  ['zendesk_list_groups', DEFAULT_LIST_CAP],
  ['zendesk_list_group_memberships', DEFAULT_MEMBERSHIP_CAP],
];

describe('registerDirectoryTools maxRecords ceilings', () => {
  const schemas = registeredSchemas();

  it.each(CASES)('%s caps maxRecords at %i', (tool, cap) => {
    const schema = schemas.get(tool)?.maxRecords;
    expect(schema).toBeDefined();
    expect(schema!.safeParse(cap).success).toBe(true);
    expect(schema!.safeParse(cap + 1).success).toBe(false);
    expect(schema!.safeParse(undefined).success).toBe(true); // optional
  });

  it('registers all six directory list/search tools', () => {
    for (const [tool] of CASES) expect(schemas.has(tool)).toBe(true);
  });
});
