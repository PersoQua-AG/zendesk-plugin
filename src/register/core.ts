// src/register/core.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { okWithHandle, toText } from '../tools/result.js';
import { getMe } from '../tools/me.js';
import { runQuery } from '../client/query.js';
import type { ToolContext } from './context.js';

export function registerCoreTools(server: McpServer, ctx: ToolContext): void {
  const { httpClient, cache } = ctx;

  server.registerTool(
    'zendesk_get_me',
    { description: 'Return the authenticated Zendesk user and role — use to verify auth is working.' },
    async () => {
      const r = await getMe(httpClient, cache);
      return okWithHandle(r);
    },
  );

  server.registerTool(
    'zendesk_query',
    {
      description: 'Re-extract fields from a previously cached tool response without re-fetching from Zendesk. Cached inbound text is already screened, so replayed content is safe.',
      inputSchema: { cacheHandle: z.string().regex(/^[A-Za-z0-9_-]+$/), query: z.string() },
    },
    async ({ cacheHandle, query }) => toText(JSON.stringify(runQuery(cache.load(cacheHandle), query), null, 2)),
  );
}
