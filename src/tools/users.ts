// src/tools/users.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { cbpPageSchema, collectCbp, type CbpPage } from '../client/paginator.js';
import type { SecurityLevel } from '../security/screen.js';
import { makeScreener, screenRecordDeep, summariseScreened, SCREEN_WARNING, type RecordScreen, type Screener } from './screening.js';
import { SEARCH_HARD_CAP } from './search.js';
import { stripUndefined } from '../util/object.js';
import type { ReadResult } from './result.js';

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
export type User = z.infer<typeof UserSchema>;

// A user carries untrusted free text in name/notes/details/phone. Screen field-agnostically
// (as search.ts does) so every string field reaches the cache neutralized/wrapped — the line
// is built from the SCREENED copy so no raw payload leaks into the summary.
function describeUser(u: User, screen: Screener): RecordScreen<User> {
  const { value, flagged } = screenRecordDeep(u, (key) => `user-${u.id}-${key}`, screen);
  const safe = value as User;
  return { safe, line: `#${safe.id} ${safe.name ?? '(no name)'} <${safe.email ?? 'no-email'}> [${safe.role ?? 'end-user'}]`, flagged };
}

const SearchUsersPageSchema = z.object({
  users: z.array(UserSchema),
  count: z.number(),
  next_page: z.string().nullable().nullish(),
});

export async function searchUsers(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { query: string; maxRecords?: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  if (params.query.trim() === '') throw new Error('A search query is required.');
  // /users/search is offset-paginated (next_page/count), like the general /search subsystem.
  // Clamp to the same 1000 ceiling so an oversized maxRecords cannot pull an unbounded set.
  const cap = Math.min(params.maxRecords ?? 100, SEARCH_HARD_CAP);
  const encoded = encodeURIComponent(params.query);

  const users: User[] = [];
  let count = 0;
  let page = 1;
  while (users.length < cap) {
    const raw = await client.request<unknown>(`/users/search.json?query=${encoded}&per_page=100&page=${page}`);
    const parsed = SearchUsersPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unexpected /users/search response shape.');
    count = parsed.data.count;
    users.push(...parsed.data.users);
    if (!parsed.data.next_page || parsed.data.users.length === 0) break;
    page += 1;
  }
  const capped = users.slice(0, cap);
  const screened = summariseScreened(capped, describeUser, securityLevel);
  const entry = cache.save('zendesk_search_users', { users: screened.records, count });
  return {
    summary: `${screened.records.length} user(s) (total ${count}):\n${screened.lines.join('\n')}${screened.warning}`,
    cacheHandle: entry.handle,
    flagged: screened.flagged,
  };
}

const SingleUserSchema = z.object({ user: UserSchema });

export async function getUser(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { userId: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const raw = await client.request<unknown>(`/users/${params.userId}.json`);
  const parsed = SingleUserSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /users/{id} response shape.');
  const { value, flagged } = screenRecordDeep(parsed.data, (key) => `user-${params.userId}-${key}`, makeScreener(securityLevel));
  const safe = value as { user: User };
  const entry = cache.save('zendesk_get_user', safe);
  const warning = flagged ? SCREEN_WARNING : '';
  return {
    summary: `User #${safe.user.id} ${safe.user.name ?? '(no name)'} <${safe.user.email ?? 'no-email'}> [${safe.user.role ?? 'end-user'}]${warning}`,
    cacheHandle: entry.handle,
    flagged,
  };
}

export interface UserWriteFields {
  name?: string;
  email?: string;
  external_id?: string;
  role?: string;
  phone?: string;
  notes?: string;
  details?: string;
  organization_id?: number;
  verified?: boolean;
}

export async function upsertUser(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { fields: UserWriteFields },
  securityLevel: SecurityLevel = 'standard',
): Promise<{ summary: string; cacheHandle: string }> {
  const f = params.fields;
  // Input validation at the trust boundary: create_or_update needs a name plus a unique
  // idempotency key (email or external_id) to be genuinely idempotent (PRD §6).
  if (!f.name || f.name.trim() === '') throw new Error('upsert_user requires a name.');
  if (!f.email && !f.external_id) throw new Error('upsert_user requires an email or external_id as the idempotency key.');
  const raw = await client.request<unknown>('/users/create_or_update.json', {
    method: 'POST',
    body: JSON.stringify({ user: f }),
  });
  const parsed = SingleUserSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /users/create_or_update response shape.');
  // The echoed record may carry attacker-influenced free text (e.g. a merged existing name).
  // Screen at ingest so the cached payload is safe at rest, not merely at replay.
  const { value: safe, flagged } = screenRecordDeep(parsed.data, (key) => `upsert-user-${parsed.data.user.id}-${key}`, makeScreener(securityLevel));
  const entry = cache.save('zendesk_upsert_user', safe);
  return { summary: `Upserted user #${parsed.data.user.id}${flagged ? SCREEN_WARNING : ''}`, cacheHandle: entry.handle };
}

export async function updateUser(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { userId: number; fields: UserWriteFields },
  securityLevel: SecurityLevel = 'standard',
): Promise<{ summary: string; cacheHandle: string }> {
  // Users have no updated_stamp safe_update path (unlike tickets); confirmation of the
  // state change is the caller's in-conversation flow (PRD §5.2). Strip undefined-valued
  // keys BEFORE the guard: {role: undefined} counts as a key but JSON.stringify drops it,
  // so guarding on raw key count would let an empty {"user":{}} PUT through.
  const defined = stripUndefined(params.fields);
  if (Object.keys(defined).length === 0) throw new Error('update_user requires at least one field to change.');
  const raw = await client.request<unknown>(`/users/${params.userId}.json`, {
    method: 'PUT',
    body: JSON.stringify({ user: defined }),
  });
  const parsed = SingleUserSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /users/{id} update response shape.');
  const { value: safe, flagged } = screenRecordDeep(parsed.data, (key) => `update-user-${params.userId}-${key}`, makeScreener(securityLevel));
  const entry = cache.save('zendesk_update_user', safe);
  return { summary: `Updated user #${params.userId}${flagged ? SCREEN_WARNING : ''}`, cacheHandle: entry.handle };
}

const IdentitySchema = z.object({
  id: z.number(),
  type: z.string().nullish(),
  value: z.string().nullish(),
  verified: z.boolean().nullish(),
  primary: z.boolean().nullish(),
  user_id: z.number().nullish(),
});
type Identity = z.infer<typeof IdentitySchema>;

const IdentitiesPageSchema = cbpPageSchema(IdentitySchema, 'identities');

function describeIdentity(i: Identity, screen: Screener): RecordScreen<Identity> {
  const { value, flagged } = screenRecordDeep(i, (key) => `identity-${i.id}-${key}`, screen);
  const safe = value as Identity;
  return { safe, line: `identity #${safe.id} [${safe.type ?? 'unknown'}] ${safe.value ?? ''}`, flagged };
}

export async function listUserIdentities(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { userId: number; maxRecords?: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const cap = params.maxRecords ?? 200;
  const fetchPage = async (cursor: string | null): Promise<CbpPage<Identity>> => {
    const parts = ['page[size]=100'];
    if (cursor) parts.push(`page[after]=${encodeURIComponent(cursor)}`);
    const raw = await client.request<unknown>(`/users/${params.userId}/identities.json?${parts.join('&')}`);
    const parsed = IdentitiesPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unexpected /users/{id}/identities response shape.');
    return { records: parsed.data.identities, meta: parsed.data.meta, links: { next: parsed.data.links?.next ?? null } };
  };

  const capped = await collectCbp(fetchPage, cap);
  const screened = summariseScreened(capped, describeIdentity, securityLevel);
  const entry = cache.save('zendesk_list_user_identities', { identities: screened.records });
  return {
    summary: `${screened.records.length} identit${screened.records.length === 1 ? 'y' : 'ies'} for user #${params.userId}:\n${screened.lines.join('\n')}${screened.warning}`,
    cacheHandle: entry.handle,
    flagged: screened.flagged,
  };
}
