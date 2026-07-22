// src/tools/users.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { cbpPageSchema, collectCbp, type CbpPage } from '../client/paginator.js';
import type { SecurityLevel } from '../security/screen.js';
import { makeScreener, screenRecordDeep, summariseScreened, SCREEN_WARNING, type RecordScreen, type Screener } from './screening.js';
import { SEARCH_HARD_CAP } from './search.js';
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
