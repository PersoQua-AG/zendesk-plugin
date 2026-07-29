import { pollJobToCompletion } from '../client/job-poller.js';
import { makeScreener, screenRecordDeep, SCREEN_WARNING } from './screening.js';
async function runJob(client, cache, toolName, path, payload, method, poll, securityLevel = 'standard') {
    const created = await client.request(path, {
        method,
        body: JSON.stringify(payload),
    });
    const final = await pollJobToCompletion(created.job_status.id, {
        fetchJobStatus: async (id) => (await client.request(`/job_statuses/${id}.json`)).job_status,
        ...poll,
    });
    // Defense in depth: job-status results carry inbound per-record error text — screen at
    // ingest so the CACHED payload is safe at rest. `failures` is surfaced to the model, so it
    // is built from the SCREENED copy: numeric ids/success flags pass through untouched (control),
    // while every error string comes back fenced. Only counts/status are read from RAW `final`.
    const { value, flagged } = screenRecordDeep(final, (key) => `${toolName}-${key}`, makeScreener(securityLevel));
    const screened = value;
    const entry = cache.save(toolName, screened);
    const failures = (screened.results ?? []).filter((r) => !r.success);
    const summary = `Job ${final.status}: ${(final.results ?? []).length} record(s), ${failures.length} failed.${flagged ? SCREEN_WARNING : ''}`;
    return { summary, cacheHandle: entry.handle, jobStatus: final.status, failures };
}
export async function createTicketsBulk(client, cache, params, poll = {}, securityLevel = 'standard') {
    if (params.tickets.length === 0)
        throw new Error('At least one ticket is required for a bulk create.');
    return runJob(client, cache, 'zendesk_create_tickets_bulk', '/tickets/create_many.json', { tickets: params.tickets }, 'POST', poll, securityLevel);
}
export async function updateTicketsBulk(client, cache, params, poll = {}, securityLevel = 'standard') {
    if (params.ids.length === 0)
        throw new Error('At least one ticket id is required for a bulk update.');
    // Safe-by-default (PRD §5.2): update_many applies one shared field set across up to 100
    // tickets with no per-ticket updatedStamp/safe_update, so it cannot do optimistic
    // concurrency and would silently clobber concurrent edits. Require force:true as the
    // explicit acknowledgment — mirroring single-update's escape hatch — rather than letting
    // a bulk write bypass the concurrency guard the single-update path enforces.
    if (!params.force) {
        throw new Error('Refusing bulk field update: update_many skips per-ticket optimistic-concurrency (safe_update) and can silently overwrite concurrent changes across up to 100 tickets. Set force:true to acknowledge and proceed with the bulk overwrite.');
    }
    const path = `/tickets/update_many.json?ids=${encodeURIComponent(params.ids.join(','))}`;
    return runJob(client, cache, 'zendesk_update_tickets_bulk', path, { ticket: params.fields }, 'PUT', poll, securityLevel);
}
