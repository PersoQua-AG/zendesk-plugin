import { z } from 'zod';
import { okWithHandle, toText } from '../tools/result.js';
import { getMe } from '../tools/me.js';
import { runQuery, screenReplay } from '../client/query.js';
import { SCREEN_WARNING } from '../tools/screening.js';
export function registerCoreTools(server, ctx) {
    const { httpClient, cache, securityLevel } = ctx;
    server.registerTool('zendesk_get_me', { description: 'Return the authenticated Zendesk user and role — use to verify auth is working.' }, async () => {
        const r = await getMe(httpClient, cache, securityLevel);
        return okWithHandle(r);
    });
    server.registerTool('zendesk_query', {
        description: 'Re-extract fields from a previously cached tool response without re-fetching from Zendesk. Extracted content is screened at the replay boundary, so any inbound string is neutralized regardless of field name.',
        inputSchema: { cacheHandle: z.string().regex(/^[A-Za-z0-9_-]+$/), query: z.string() },
    }, async ({ cacheHandle, query }) => {
        const { value, flagged } = screenReplay(runQuery(cache.load(cacheHandle), query), securityLevel);
        const body = JSON.stringify(value, null, 2);
        return toText(flagged ? `${body}${SCREEN_WARNING}` : body);
    });
}
