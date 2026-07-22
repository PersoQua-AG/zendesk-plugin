// src/tools/ticket-bulk.ts
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { pollJobToCompletion, type JobStatus, type JobPollerOptions } from '../client/job-poller.js';
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
): Promise<BulkResult> {
  const created = await client.request<{ job_status: { id: string } }>(path, {
    method,
    body: JSON.stringify(payload),
  });
  const final = await pollJobToCompletion(created.job_status.id, {
    fetchJobStatus: async (id) => (await client.request<{ job_status: JobStatus }>(`/job_statuses/${id}.json`)).job_status,
    ...poll,
  });
  const entry = cache.save(toolName, final);
  const failures = (final.results ?? []).filter((r) => !r.success);
  const summary = `Job ${final.status}: ${(final.results ?? []).length} record(s), ${failures.length} failed.`;
  return { summary, cacheHandle: entry.handle, jobStatus: final.status, failures };
}

export async function createTicketsBulk(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { tickets: unknown[] },
  poll: PollOverrides = {},
): Promise<BulkResult> {
  if (params.tickets.length === 0) throw new Error('At least one ticket is required for a bulk create.');
  return runJob(client, cache, 'zendesk_create_tickets_bulk', '/tickets/create_many.json', { tickets: params.tickets }, 'POST', poll);
}

export async function updateTicketsBulk(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { ids: number[]; fields: TicketUpdateFields },
  poll: PollOverrides = {},
): Promise<BulkResult> {
  if (params.ids.length === 0) throw new Error('At least one ticket id is required for a bulk update.');
  const path = `/tickets/update_many.json?ids=${encodeURIComponent(params.ids.join(','))}`;
  return runJob(client, cache, 'zendesk_update_tickets_bulk', path, { ticket: params.fields }, 'PUT', poll);
}
