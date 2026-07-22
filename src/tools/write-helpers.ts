// src/tools/write-helpers.ts
// Shared write-side helpers for M4+ mutating tools. Two duplicated patterns are extracted here
// so M5 (guide, write-heavy) can reuse them rather than re-clone the surface:
//   1. safeUpdateWithConflict — the optimistic-concurrency PUT (safe_update/updated_stamp →
//      409 → re-fetch → screen → conflict result). Shared by ticket update and macro apply.
//   2. updateEntity — the plain-PUT update tail (strip → empty-guard → PUT → parse-for-id →
//      screen → cache → summary). Shared by user/org/rule updates.
// Both screen inbound content BEFORE caching, so ingest screening stays enforced by construction.
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import type { SecurityLevel } from '../security/screen.js';
import { makeScreener, screenRecordDeep, SCREEN_WARNING } from './screening.js';
import { ZendeskConflictError } from '../client/errors.js';
import { stripUndefined } from '../util/object.js';

// The shared optimistic-concurrency mutation result. `applied` is the success arm; `conflict`
// carries the re-fetched current stamp so a caller can re-read → review → re-confirm.
export type MutationResult =
  | { status: 'applied'; summary: string; cacheHandle: string }
  | { status: 'conflict'; summary: string; cacheHandle: string; currentUpdatedStamp: string | null };

// The current state a conflict re-fetch exposes to a caller's summary builder. `subject` is
// already screened (wrapped) when present, so a conflict summary never leaks raw payload.
export interface ConflictSnapshot {
  status: string | null;
  subject: string | null;
}

export interface SafeUpdateOptions {
  path: string; // PUT target + conflict re-fetch GET, e.g. '/tickets/42.json'
  envelopeKey: string; // request/response wrapper key, e.g. 'ticket'
  body: Record<string, unknown>; // fields to PUT (safe_update is layered on here, not by caller)
  updatedStamp?: string; // optimistic-concurrency stamp; attaches safe_update when present
  force?: boolean; // deliberate overwrite — omits safe_update (caller must have gated this)
  toolName: string; // success cache tool name; conflict caches under `${toolName}_conflict`
  seedPrefix: string; // screening label seed, e.g. 'update-ticket-42'
  securityLevel: SecurityLevel;
  appliedSummary: string; // success summary base; SCREEN_WARNING is appended when flagged
  conflictSummary: (current: ConflictSnapshot) => string;
}

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

export async function safeUpdateWithConflict(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  opts: SafeUpdateOptions,
): Promise<MutationResult> {
  const screener = makeScreener(opts.securityLevel);
  // Immutable copy — never mutate the caller's body. Attach the optimistic-concurrency
  // envelope only when a stamp is supplied; force is the deliberate no-stamp overwrite path.
  const body: Record<string, unknown> = { ...opts.body };
  if (opts.updatedStamp) {
    body.safe_update = true;
    body.updated_stamp = opts.updatedStamp;
  }
  try {
    const raw = await client.request<unknown>(opts.path, {
      method: 'PUT',
      body: JSON.stringify({ [opts.envelopeKey]: body }),
    });
    // Defense in depth: the PUT echo carries attacker-influenced free text — screen at ingest
    // so the cached payload is safe at rest, not solely reliant on the replay-boundary net.
    const { value: safe, flagged } = screenRecordDeep(raw, (key) => `${opts.seedPrefix}-${key}`, screener);
    const entry = cache.save(opts.toolName, safe);
    return { status: 'applied', summary: `${opts.appliedSummary}${flagged ? SCREEN_WARNING : ''}`, cacheHandle: entry.handle };
  } catch (err) {
    if (!(err instanceof ZendeskConflictError)) throw err;
    const current = await client.request<unknown>(opts.path);
    const parsed = ConflictRefetchSchema.safeParse(current);
    if (!parsed.success) throw new Error('Conflict re-fetch returned a malformed /tickets/{id} response.');
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

// A guard wraps the PUT so a resource can re-map a permission error (rules pass withAdminGuard;
// users/orgs pass nothing = run directly).
export type WriteGuard = <T>(action: string, thunk: () => Promise<T>) => Promise<T>;

export interface UpdateEntityConfig {
  collection: string; // e.g. '/users', '/triggers'
  key: string; // envelope key, e.g. 'user', 'trigger'
  toolName: string; // cache tool name, e.g. 'zendesk_update_user'
  resourceLabel: string; // human label for guard/summary, e.g. 'user', 'organization'
  guard?: WriteGuard;
}

// Id-bearing update echo. passthrough keeps the full record for screening/caching; only `id`
// is structurally required so the tail is field-agnostic (the boundary type lives on callers).
const IdRecordSchema = z.object({ id: z.number() }).passthrough();

export async function updateEntity<F extends object>(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  config: UpdateEntityConfig,
  id: number,
  fields: F,
  securityLevel: SecurityLevel,
): Promise<{ summary: string; cacheHandle: string }> {
  // Strip undefined-valued keys BEFORE the guard: {name: undefined} counts as a key but
  // JSON.stringify drops it, so a raw key-count guard would let an empty PUT through.
  const body = stripUndefined(fields);
  if (Object.keys(body).length === 0) throw new Error(`update_${config.resourceLabel} requires at least one field to change.`);
  const run = () =>
    client.request<unknown>(`${config.collection}/${id}.json`, { method: 'PUT', body: JSON.stringify({ [config.key]: body }) });
  const raw = config.guard ? await config.guard(`Updating a ${config.resourceLabel}`, run) : await run();
  const parsed = z.object({ [config.key]: IdRecordSchema }).passthrough().safeParse(raw);
  if (!parsed.success) throw new Error(`Unexpected ${config.collection}/{id} update response shape.`);
  const { value: safe, flagged } = screenRecordDeep(parsed.data, (key) => `${config.toolName}-${id}-${key}`, makeScreener(securityLevel));
  const entry = cache.save(config.toolName, safe);
  return { summary: `Updated ${config.resourceLabel} #${id}${flagged ? SCREEN_WARNING : ''}`, cacheHandle: entry.handle };
}
