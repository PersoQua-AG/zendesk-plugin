// src/tools/users.ts
import { z } from 'zod';
import { makeDescribe, makeScreener, screenRecordDeep, summariseScreened, SCREEN_WARNING } from './screening.js';
import { SEARCH_HARD_CAP } from './search.js';
import { listCbp, DEFAULT_LIST_CAP } from './cbp-list.js';
import { collectOffset } from '../client/paginator.js';
import { updateEntity } from './write-helpers.js';
const UserSchema = z.object({
    id: z.number(),
    name: z.string().nullish(),
    email: z.string().nullish(),
    role: z.string().nullish(),
    external_id: z.string().nullish(),
    organization_id: z.number().nullish(),
    phone: z.string().nullish(),
    notes: z.string().nullish(),
    details: z.string().nullish(),
    verified: z.boolean().nullish(),
    suspended: z.boolean().nullish(),
    updated_at: z.string().nullish(),
});
// A user carries untrusted free text in name/notes/details/phone; every string field reaches
// the cache neutralized/wrapped and the line is rendered from the SCREENED copy so no raw
// payload leaks into the summary.
const describeUser = makeDescribe('user', (u) => `#${u.id} ${u.name ?? '(no name)'} <${u.email ?? 'no-email'}> [${u.role ?? 'end-user'}]`);
const SearchUsersPageSchema = z.object({
    users: z.array(UserSchema),
    count: z.number(),
    next_page: z.string().nullable().nullish(),
});
export async function searchUsers(client, cache, params, securityLevel = 'standard') {
    if (params.query.trim() === '')
        throw new Error('A search query is required.');
    // /users/search is offset-paginated (next_page/count), like the general /search subsystem.
    // Clamp to the same 1000 ceiling so an oversized maxRecords cannot pull an unbounded set.
    const cap = Math.min(params.maxRecords ?? 100, SEARCH_HARD_CAP);
    const encoded = encodeURIComponent(params.query);
    let count = 0;
    const capped = await collectOffset(async (page) => {
        const raw = await client.request(`/users/search.json?query=${encoded}&per_page=100&page=${page}`);
        const parsed = SearchUsersPageSchema.safeParse(raw);
        if (!parsed.success)
            throw new Error('Unexpected /users/search response shape.');
        count = parsed.data.count;
        return { records: parsed.data.users, nextPage: parsed.data.next_page ?? null };
    }, cap);
    const screened = summariseScreened(capped, describeUser, securityLevel);
    const entry = cache.save('zendesk_search_users', { users: screened.records, count });
    return {
        summary: `${screened.records.length} user(s) (total ${count}):\n${screened.lines.join('\n')}${screened.warning}`,
        cacheHandle: entry.handle,
        flagged: screened.flagged,
    };
}
const SingleUserSchema = z.object({ user: UserSchema });
export async function getUser(client, cache, params, securityLevel = 'standard') {
    const raw = await client.request(`/users/${params.userId}.json`);
    const parsed = SingleUserSchema.safeParse(raw);
    if (!parsed.success)
        throw new Error('Unexpected /users/{id} response shape.');
    const { value, flagged } = screenRecordDeep(parsed.data, (key) => `user-${params.userId}-${key}`, makeScreener(securityLevel));
    const safe = value;
    const entry = cache.save('zendesk_get_user', safe);
    const warning = flagged ? SCREEN_WARNING : '';
    // name/email are attacker-controllable free text — render them from the FENCED `safe.user`,
    // never raw. role is a server-controlled enum, so it may read raw. id is numeric (control).
    const u = safe.user;
    return {
        summary: `User #${u.id} ${u.name ?? '(no name)'} <${u.email ?? 'no-email'}> [${u.role ?? 'end-user'}]${warning}`,
        cacheHandle: entry.handle,
        flagged,
    };
}
export async function upsertUser(client, cache, params, securityLevel = 'standard') {
    const f = params.fields;
    // Input validation at the trust boundary: create_or_update needs a name plus a unique
    // idempotency key (email or external_id) to be genuinely idempotent (PRD §6).
    if (!f.name || f.name.trim() === '')
        throw new Error('upsert_user requires a name.');
    if (!f.email && !f.external_id)
        throw new Error('upsert_user requires an email or external_id as the idempotency key.');
    const raw = await client.request('/users/create_or_update.json', {
        method: 'POST',
        body: JSON.stringify({ user: f }),
    });
    const parsed = SingleUserSchema.safeParse(raw);
    if (!parsed.success)
        throw new Error('Unexpected /users/create_or_update response shape.');
    // The echoed record may carry attacker-influenced free text (e.g. a merged existing name).
    // Screen at ingest so the cached payload is safe at rest, not merely at replay.
    const { value: safe, flagged } = screenRecordDeep(parsed.data, (key) => `upsert-user-${parsed.data.user.id}-${key}`, makeScreener(securityLevel));
    const entry = cache.save('zendesk_upsert_user', safe);
    return { summary: `Upserted user #${parsed.data.user.id}${flagged ? SCREEN_WARNING : ''}`, cacheHandle: entry.handle };
}
export async function updateUser(client, cache, params, securityLevel = 'standard') {
    // Users have no updated_stamp safe_update path (unlike tickets); confirmation of the state
    // change is the caller's in-conversation flow (PRD §5.2). The plain-PUT update tail is shared.
    return updateEntity(client, cache, { collection: '/users', key: 'user', toolName: 'zendesk_update_user', resourceLabel: 'user' }, params.userId, params.fields, securityLevel);
}
const IdentitySchema = z.object({
    id: z.number(),
    type: z.string().nullish(),
    value: z.string().nullish(),
    verified: z.boolean().nullish(),
    primary: z.boolean().nullish(),
    user_id: z.number().nullish(),
});
const describeIdentity = makeDescribe('identity', (i) => `identity #${i.id} [${i.type ?? 'unknown'}] ${i.value ?? ''}`);
export async function listUserIdentities(client, cache, params, securityLevel = 'standard') {
    return listCbp({
        client,
        cache,
        securityLevel,
        path: `/users/${params.userId}/identities.json`,
        key: 'identities',
        schema: IdentitySchema,
        describe: describeIdentity,
        handle: 'zendesk_list_user_identities',
        cap: params.maxRecords ?? DEFAULT_LIST_CAP,
        pageSize: params.pageSize,
        // The one irregular plural: identity → identities. Owned by the label fn.
        label: (n) => `${n} identit${n === 1 ? 'y' : 'ies'} for user #${params.userId}`,
        errorLabel: '/users/{id}/identities',
    });
}
