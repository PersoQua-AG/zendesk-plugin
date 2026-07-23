// tests/register/guide.test.ts
// QA #3: pin the Guide register boundary — localeSchema must REJECT a path-segment locale so a
// traversal ("../", "foo/bar") can never reach a URL path segment via MCP. Captured off the
// zendesk_update_article_translation tool (where locale is the path key), asserting the boundary
// rejects traversal shapes while accepting the first-class locales. Not tautological: it exercises
// the regex that fronts the locale-keyed translation PUT.
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { registerGuideTools } from '../../src/register/guide.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../../src/register/context.js';

type InputSchema = Record<string, z.ZodTypeAny>;

function registeredSchemas(): Map<string, InputSchema> {
  const tools = new Map<string, InputSchema>();
  const server = {
    registerTool: (name: string, def: { inputSchema?: InputSchema }) => tools.set(name, def.inputSchema ?? {}),
  } as unknown as McpServer;
  const ctx = { httpClient: {}, cache: {}, securityLevel: 'standard', markdownDefault: true } as unknown as ToolContext;
  registerGuideTools(server, ctx);
  return tools;
}

describe('registerGuideTools locale boundary', () => {
  const localeSchema = registeredSchemas().get('zendesk_update_article_translation')?.locale;

  it('exposes a required locale schema on the translation-update tool', () => {
    expect(localeSchema).toBeDefined();
  });

  it.each(['../', '../../users/1', 'foo/bar', 'en_us/../x', 'de/'])('rejects path-segment locale %j', (bad) => {
    expect(localeSchema!.safeParse(bad).success).toBe(false);
  });

  it.each(['de', 'en-us', 'pt-br', 'zh-cn'])('accepts well-formed locale %j', (ok) => {
    expect(localeSchema!.safeParse(ok).success).toBe(true);
  });
});
