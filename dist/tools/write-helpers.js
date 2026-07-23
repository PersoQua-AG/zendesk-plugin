// src/tools/write-helpers.ts
// Shared write-side helpers for M4+ mutating tools. Three duplicated patterns are extracted here
// so every domain (tickets, business-rules, guide) reuses them rather than re-clone the surface,
// and so no domain owns a generic another domain must reach across a boundary to import:
//   1. safeUpdateWithConflict — the optimistic-concurrency PUT (safe_update/updated_stamp →
//      409 → re-fetch → screen → conflict result). Shared by ticket update and macro apply.
//   2. updateEntity — the plain-PUT update tail (strip → empty-guard → PUT → parse-for-id →
//      screen → cache → summary). Shared by user/org/rule/guide updates.
//   3. createEntity — the generic POST-create tail (required-fields → strip → guard → POST →
//      parse-for-id → screen → cache → summary). Twin of updateEntity, shared by rule + guide creates.
// withAdminGuard (the shared admin-role 403 re-mapper) lives here too so it stays neutral rather
// than domain-owned. All three screen inbound content BEFORE caching, so ingest screening stays
// enforced by construction.
import { z } from 'zod';
import { makeScreener, screenRecordDeep, SCREEN_WARNING } from './screening.js';
import { ZendeskConflictError, ZendeskPermissionError } from '../client/errors.js';
import { stripUndefined } from '../util/object.js';
// The two mutating callers both re-fetch a ticket on 409. Keep the re-fetch schema minimal:
// only the fields a conflict summary needs (id/status/subject/updated_at).
const ConflictRefetchSchema = z.object({
    ticket: z.object({
        id: z.number(),
        status: z.string().nullish(),
        subject: z.string().nullish(),
        updated_at: z.string().nullish(),
    }),
});
export async function safeUpdateWithConflict(client, cache, opts) {
    const screener = makeScreener(opts.securityLevel);
    // Immutable copy — never mutate the caller's body. Attach the optimistic-concurrency
    // envelope only when a stamp is supplied; force is the deliberate no-stamp overwrite path.
    const body = { ...opts.body };
    if (opts.updatedStamp) {
        body.safe_update = true;
        body.updated_stamp = opts.updatedStamp;
    }
    try {
        const raw = await client.request(opts.path, {
            method: 'PUT',
            body: JSON.stringify({ [opts.envelopeKey]: body }),
        });
        // Defense in depth: the PUT echo carries attacker-influenced free text — screen at ingest
        // so the cached payload is safe at rest, not solely reliant on the replay-boundary net.
        const { value: safe, flagged } = screenRecordDeep(raw, (key) => `${opts.seedPrefix}-${key}`, screener);
        const entry = cache.save(opts.toolName, safe);
        return { status: 'applied', summary: `${opts.appliedSummary}${flagged ? SCREEN_WARNING : ''}`, cacheHandle: entry.handle };
    }
    catch (err) {
        if (!(err instanceof ZendeskConflictError))
            throw err;
        const current = await client.request(opts.path);
        const parsed = ConflictRefetchSchema.safeParse(current);
        if (!parsed.success)
            throw new Error('Conflict re-fetch returned a malformed /tickets/{id} response.');
        const { value: safe } = screenRecordDeep(parsed.data, (key) => `${opts.seedPrefix}-conflict-${key}`, screener);
        const entry = cache.save(`${opts.toolName}_conflict`, safe);
        const t = parsed.data.ticket;
        const subject = t.subject != null ? screener(t.subject, `${opts.seedPrefix}-conflict-subject`).wrapped : null;
        return {
            status: 'conflict',
            summary: opts.conflictSummary({ status: t.status ?? null, subject }),
            cacheHandle: entry.handle,
            currentUpdatedStamp: t.updated_at ?? null,
        };
    }
}
// A plan-gated or object-scoped 403 must keep its Zendesk detail; only a scope∩role/admin
// denial is re-mapped to the actionable guidance below.
function isAdminScopeDenial(message) {
    return !/\bplan\b|feature|not available|upgrade|subscription/i.test(message);
}
// Admin-gated writes (business rules, Guide) require an admin role. The base client maps a 403 to a
// generic ZendeskPermissionError; re-map a genuine scope∩role denial to an actionable, resource-
// specific message (preserving the original as `cause`). Non-403s and plan/feature 403s pass through.
export const withAdminGuard = async (action, thunk) => {
    try {
        return await thunk();
    }
    catch (err) {
        if (err instanceof ZendeskPermissionError && isAdminScopeDenial(err.message)) {
            const relabelled = new ZendeskPermissionError(`${action} requires an admin role — your token's scope ∩ role is insufficient. Re-authorize with an admin account or ask an admin to make this change.`);
            relabelled.cause = err;
            throw relabelled;
        }
        throw err;
    }
};
// Id-bearing update echo. passthrough keeps the full record for screening/caching; only `id`
// is structurally required so the tail is field-agnostic (the boundary type lives on callers).
const IdRecordSchema = z.object({ id: z.number() }).passthrough();
export async function updateEntity(client, cache, config, id, fields, securityLevel) {
    // Strip undefined-valued keys BEFORE the guard: {name: undefined} counts as a key but
    // JSON.stringify drops it, so a raw key-count guard would let an empty PUT through.
    const body = stripUndefined(fields);
    if (Object.keys(body).length === 0)
        throw new Error(`update_${config.resourceLabel} requires at least one field to change.`);
    // Defense in depth: percent-encode the id/locale so a traversal segment (e.g. a "../"-style
    // locale from a direct in-process caller) stays one inert path component and cannot escape the
    // collection. Not reachable via MCP (the register regex rejects it), but the helper is safe alone.
    const run = () => client.request(`${config.collection}/${encodeURIComponent(String(id))}.json`, { method: 'PUT', body: JSON.stringify({ [config.key]: body }) });
    const raw = config.guard ? await config.guard(`Updating a ${config.resourceLabel}`, run) : await run();
    const parsed = z.object({ [config.key]: IdRecordSchema }).passthrough().safeParse(raw);
    if (!parsed.success)
        throw new Error(`Unexpected ${config.collection}/{id} update response shape.`);
    const { value: safe, flagged } = screenRecordDeep(parsed.data, (key) => `${config.toolName}-${id}-${key}`, makeScreener(securityLevel));
    const entry = cache.save(config.toolName, safe);
    // A numeric id reads as "#42"; a string id (e.g. a translation locale) uses "(de)" since "#"
    // implies a numeric record id.
    const idLabel = typeof id === 'number' ? `#${id}` : `(${id})`;
    return { summary: `Updated ${config.resourceLabel} ${idLabel}${flagged ? SCREEN_WARNING : ''}`, cacheHandle: entry.handle };
}
// The generic POST-create tail — twin of updateEntity. passthrough keeps the full record for
// screening/caching; only `id` is structurally required so the tail stays field-agnostic (the
// precise field shape lives on callers). Screens the echo BEFORE caching, like every write helper.
export async function createEntity(client, cache, config, fields, securityLevel) {
    for (const field of config.requiredFields) {
        const value = fields[field];
        if (typeof value !== 'string' || value.trim() === '')
            throw new Error(`create_${config.resourceLabel} requires a ${field}.`);
    }
    const body = stripUndefined(fields);
    const run = () => client.request(`${config.collection}.json`, { method: 'POST', body: JSON.stringify({ [config.key]: body }) });
    const raw = config.guard ? await config.guard(`Creating a ${config.resourceLabel}`, run) : await run();
    const parsed = z.object({ [config.key]: IdRecordSchema }).passthrough().safeParse(raw);
    if (!parsed.success)
        throw new Error(`Unexpected ${config.collection} create response shape.`);
    const record = parsed.data[config.key];
    const { value: safe, flagged } = screenRecordDeep(parsed.data, (key) => `${config.toolName}-${record.id}-${key}`, makeScreener(securityLevel));
    const entry = cache.save(config.toolName, safe);
    return { summary: `Created ${config.resourceLabel} #${record.id}${flagged ? SCREEN_WARNING : ''}`, cacheHandle: entry.handle };
}
