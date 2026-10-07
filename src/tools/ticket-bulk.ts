// src/tools/ticket-bulk.ts
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { CacheStore } from '../client/cache.js';
import { pollJobToCompletion, type JobStatus, type JobPollerOptions } from '../client/job-poller.js';
import type { SecurityLevel } from '../security/screen.js';
import { makeScreener, screenRecordDeep, screenNote } from './screening.js';
import type { TicketUpdateFields } from './tickets.js';
import { readStatuses, refusalReason, BIRTH_STATE_REFUSAL, type RefusalReason } from './ticket-status.js';

type PollOverrides = Partial<Pick<JobPollerOptions, 'sleep' | 'intervalMs' | 'maxAttempts'>>;

export interface BulkResult {
  summary: string;
  cacheHandle: string;
  jobStatus: JobStatus['status'];
  failures: NonNullable<JobStatus['results']>;
}

async function runJob(
  client: ZendeskHttpClient,
  cache: CacheStore,
  toolName: string,
  path: string,
  payload: unknown,
  method: 'POST' | 'PUT',
  poll: PollOverrides,
  securityLevel: SecurityLevel = 'standard',
): Promise<BulkResult> {
  const created = await client.request<{ job_status: { id: string } }>(path, {
    method,
    body: JSON.stringify(payload),
  });
  const final = await pollJobToCompletion(created.job_status.id, {
    fetchJobStatus: async (id) => (await client.request<{ job_status: JobStatus }>(`/job_statuses/${id}.json`)).job_status,
    ...poll,
  });
  // Defense in depth: job-status results carry inbound per-record error text — screen at
  // ingest so the CACHED payload is safe at rest. `failures` is surfaced to the model, so it
  // is built from the SCREENED copy: numeric ids/success flags pass through untouched (control),
  // while every error string comes back fenced. Only counts/status are read from RAW `final`.
  const { value, flagged } = screenRecordDeep(final, (key) => `${toolName}-${key}`, makeScreener(securityLevel));
  const screened = value as JobStatus;
  const entry = cache.save(toolName, screened);
  const failures = (screened.results ?? []).filter((r) => !r.success);
  const summary = `Job ${final.status}: ${(final.results ?? []).length} record(s), ${failures.length} failed.${screenNote(flagged, securityLevel)}`;
  return { summary, cacheHandle: entry.handle, jobStatus: final.status, failures };
}

export async function createTicketsBulk(
  client: ZendeskHttpClient,
  cache: CacheStore,
  params: { tickets: unknown[] },
  poll: PollOverrides = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<BulkResult> {
  if (params.tickets.length === 0) throw new Error('At least one ticket is required for a bulk create.');
  return runJob(client, cache, 'zendesk_create_tickets_bulk', '/tickets/create_many.json', { tickets: params.tickets }, 'POST', poll, securityLevel);
}

// The bulk wording for each refusal reason refusalReason can hand back after the read.
function bulkCause(reason: RefusalReason, target: string): string {
  switch (reason) {
    case 'terminal':
      return `Refused on a forbidden status transition to ${target}`;
    case 'unpublished':
      return 'Current status is not one of the published statuses, so the lifecycle rules could not be checked';
    default:
      return 'Current status could not be read, so the lifecycle rules could not be checked';
  }
}

export async function updateTicketsBulk(
  client: ZendeskHttpClient,
  cache: CacheStore,
  params: { ids: number[]; fields: TicketUpdateFields; force?: boolean },
  poll: PollOverrides = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<BulkResult> {
  if (params.ids.length === 0) throw new Error('At least one ticket id is required for a bulk update.');
  // Safe-by-default (PRD §5.2): update_many applies one shared field set across up to 100
  // tickets with no per-ticket updatedStamp/safe_update, so it cannot do optimistic
  // concurrency and would silently clobber concurrent edits. Require force:true as the
  // explicit acknowledgment — mirroring single-update's escape hatch — rather than letting
  // a bulk write bypass the concurrency guard the single-update path enforces.
  if (!params.force) {
    throw new Error(
      'Refusing bulk field update: update_many skips per-ticket optimistic-concurrency (safe_update) and can silently overwrite concurrent changes across up to 100 tickets. Set force:true to acknowledge and proceed with the bulk overwrite.',
    );
  }
  // #61: update_many shares one field set across up to 100 tickets, so the lifecycle table is
  // checked per ticket and the refused ones are dropped from the batch and named in the result.
  let ids = params.ids;
  let refusedNote = '';
  const target = params.fields.status;
  if (target !== undefined) {
    // → new is refused from every state, so the batch needs no read, and it ends with the SAME
    // sentence the single path gives: the generic wrapper below would not say `new` is the birth state.
    if (target === 'new') throw new Error(BIRTH_STATE_REFUSAL);
    const statuses = await readStatuses(client, params.ids);
    // The judgment is refusalReason's alone — the causes are only GROUPED here, because one note
    // must name the ids per cause: "forbidden transition" sends the model to the linked-follow-up
    // remedy, which is wrong advice for a ticket show_many never answered for.
    const refusedBy = new Map<RefusalReason, number[]>();
    for (const id of params.ids) {
      const reason = refusalReason(statuses.get(id) ?? null, target);
      if (reason) refusedBy.set(reason, [...(refusedBy.get(reason) ?? []), id]);
    }
    if (refusedBy.size > 0) {
      const refused = new Set([...refusedBy.values()].flat());
      ids = params.ids.filter((id) => !refused.has(id));
      refusedNote = [...refusedBy].map(([reason, rs]) => ` ${bulkCause(reason, target)}, not written: ${rs.join(', ')}.`).join('');
      if (ids.length === 0) throw new Error(`Refusing the bulk update — no ticket in the batch may move to ${target}.${refusedNote}`);
    }
  }
  const path = `/tickets/update_many.json?ids=${encodeURIComponent(ids.join(','))}`;
  const result = await runJob(client, cache, 'zendesk_update_tickets_bulk', path, { ticket: params.fields }, 'PUT', poll, securityLevel);
  return refusedNote ? { ...result, summary: `${result.summary}${refusedNote}` } : result;
}
