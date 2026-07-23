// src/tools/ticket-comments.ts
import { z } from 'zod';
import { makeScreener, screenRecordDeep, SCREEN_WARNING } from './screening.js';
import { listCbp } from './cbp-list.js';
import { buildComment } from './tickets.js';
export async function addComment(client, cache, 
// `markdown` is a resolved boolean (the register layer applies the markdown_conversion default);
// the tool holds no hidden default of its own, matching the Guide write path.
params, securityLevel = 'standard') {
    if (params.body.trim() === '')
        throw new Error('Comment body must not be empty.');
    const isPublic = params.public ?? true;
    const comment = buildComment(params.body, params.markdown, isPublic);
    const raw = await client.request(`/tickets/${params.ticketId}.json`, {
        method: 'PUT',
        body: JSON.stringify({ ticket: { comment } }),
    });
    // Defense in depth: the PUT response echoes the full ticket (incl. attacker-controlled
    // subject). Screen at ingest so the cached payload is safe at rest.
    const { value: safe, flagged } = screenRecordDeep(raw, (key) => `add-comment-${params.ticketId}-${key}`, makeScreener(securityLevel));
    const entry = cache.save('zendesk_add_comment', safe);
    return { summary: `Added ${isPublic ? 'public' : 'internal'} comment to ticket #${params.ticketId}${flagged ? SCREEN_WARNING : ''}`, cacheHandle: entry.handle };
}
const CommentSchema = z.object({
    id: z.number(),
    author_id: z.number().nullish(),
    public: z.boolean().nullish(),
    body: z.string().nullish(),
});
function describeComment(c, screen) {
    const body = screen(c.body ?? '', `comment-${c.id}`);
    return {
        safe: { ...c, ...(typeof c.body === 'string' ? { body: body.wrapped } : {}) },
        line: `comment #${c.id}${c.public === false ? ' (internal)' : ''}`,
        flagged: body.flagged,
    };
}
export async function listComments(client, cache, params, securityLevel = 'standard') {
    return listCbp({
        client,
        cache,
        securityLevel,
        path: `/tickets/${params.ticketId}/comments.json`,
        key: 'comments',
        schema: CommentSchema,
        describe: describeComment,
        handle: 'zendesk_list_comments',
        cap: params.maxRecords ?? 500,
        summary: (n) => `${n} comment(s) on ticket #${params.ticketId}`,
        errorLabel: '/tickets/{id}/comments',
    });
}
