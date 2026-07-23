import { z } from 'zod';
import { okWithHandle, toText } from '../tools/result.js';
import { search, searchExport, searchCount, SEARCH_HARD_CAP } from '../tools/search.js';
const searchType = z.enum(['ticket', 'user', 'organization', 'group']);
export function registerSearchTools(server, ctx) {
    const { httpClient, cache, securityLevel } = ctx;
    server.registerTool('zendesk_search', {
        description: 'Search Zendesk (≤1000 results). Optionally set type (ticket|user|organization|group).',
        inputSchema: { query: z.string().min(1), type: searchType.optional(), maxRecords: z.number().int().positive().max(SEARCH_HARD_CAP).optional() },
    }, async (args) => okWithHandle(await search(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_search_export', {
        description: 'Export large search result sets (cursor-paginated). Requires a type filter.',
        inputSchema: { query: z.string().min(1), type: z.string().min(1), maxRecords: z.number().int().positive().max(SEARCH_HARD_CAP).optional() },
    }, async (args) => okWithHandle(await searchExport(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_search_count', { description: 'Count records matching a search query (no result bodies fetched).', inputSchema: { query: z.string().min(1) } }, async ({ query }) => toText((await searchCount(httpClient, { query })).summary));
}
