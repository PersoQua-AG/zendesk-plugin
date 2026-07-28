// src/tools/ticket-bulk.ts
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { pollJobToCompletion, type JobStatus, type JobPollerOptions } from '../client/job-poller.js';
import type { SecurityLevel } from '../security/screen.js';
import { makeScreener, screenRecordDeep, SCREEN_WARNING } from './screening.js';
import type { TicketUpdateFields } from './tickets.js';

type PollOverrides = Partial<Pick<JobPollerOptions, 'sleep' | 'intervalMs' | 'maxAttempts'>>;

export interface BulkResult {
  summary: string;
  cacheHandle: string;
  jobStatus: JobStatus['status'];
  failures: NonNullable<JobStatus['results']>;
}

async function runJob(
  client: ZendeskHttpClient,
  cache: ResponseCache,
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
  // ingest so the CACHED payload is safe at rest. Fencing wraps every string, so control fields
  // (job status, per-record error text surfaced to the caller) are read from the RAW `final`;
  // the cache holds the screened copy.
  const { value, flagged } = screenRecordDeep(final, (key) => `${toolName}-${key}`, makeScreener(securityLevel));
  const entry = cache.save(toolName, value as JobStatus);
  const failures = (final.results ?? []).filter((r) => !r.success);
  const summary = `Job ${final.status}: ${(final.results ?? []).length} record(s), ${failures.length} failed.${flagged ? SCREEN_WARNING : ''}`;
  return { summary, cacheHandle: entry.handle, jobStatus: final.status, failures };
}

export async function createTicketsBulk(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { tickets: unknown[] },
  poll: PollOverrides = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<BulkResult> {
  if (params.tickets.length === 0) throw new Error('At least one ticket is required for a bulk create.');
  return runJob(client, cache, 'zendesk_create_tickets_bulk', '/tickets/create_many.json', { tickets: params.tickets }, 'POST', poll, securityLevel);
}

export async function updateTicketsBulk(
  client: ZendeskHttpClient,
  cache: ResponseCache,
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
  const path = `/tickets/update_many.json?ids=${encodeURIComponent(params.ids.join(','))}`;
  return runJob(client, cache, 'zendesk_update_tickets_bulk', path, { ticket: params.fields }, 'PUT', poll, securityLevel);
}
