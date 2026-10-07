import { pollJobToCompletion } from '../client/job-poller.js';
import { makeScreener, screenRecordDeep, screenNote } from './screening.js';
import { readStatuses, transitionRefusal } from './ticket-status.js';
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
    const summary = `Job ${final.status}: ${(final.results ?? []).length} record(s), ${failures.length} failed.${screenNote(flagged, securityLevel)}`;
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
    // #61: update_many shares one field set across up to 100 tickets, so the lifecycle table is
    // checked per ticket and the refused ones are dropped from the batch and named in the result —
    // a single forbidden ticket must neither be written nor cancel the rest of the batch.
    let ids = params.ids;
    let refusedNote = '';
    const target = params.fields.status;
    if (target !== undefined) {
        // → new is refused from every state, so the batch needs no read to settle it.
        const statuses = target === 'new' ? new Map() : await readStatuses(client, params.ids);
        // Two causes, reported apart. An id show_many did not answer for (a deleted ticket, a truncated
        // response, a record that did not parse) has no known status, so it is refused — but calling
        // that "a forbidden status transition" sends the model to the linked-follow-up remedy for a
        // ticket that may not exist. The lifecycle refusal is only for ids whose status was read.
        const unreadable = target === 'new' ? [] : params.ids.filter((id) => !statuses.has(id) || statuses.get(id) === null);
        const unreadableSet = new Set(unreadable);
        const forbidden = params.ids.filter((id) => !unreadableSet.has(id) && transitionRefusal(statuses.get(id) ?? null, target));
        const refused = new Set([...unreadable, ...forbidden]);
        if (refused.size > 0) {
            ids = params.ids.filter((id) => !refused.has(id));
            refusedNote =
                (forbidden.length > 0 ? ` Refused on a forbidden status transition to ${target}, not written: ${forbidden.join(', ')}.` : '') +
                    (unreadable.length > 0 ? ` Current status could not be read, so the lifecycle rules could not be checked and these were not written: ${unreadable.join(', ')}.` : '');
            if (ids.length === 0)
                throw new Error(`Refusing the bulk update — no ticket in the batch may move to ${target}.${refusedNote}`);
        }
    }
    const path = `/tickets/update_many.json?ids=${encodeURIComponent(ids.join(','))}`;
    const result = await runJob(client, cache, 'zendesk_update_tickets_bulk', path, { ticket: params.fields }, 'PUT', poll, securityLevel);
    return refusedNote ? { ...result, summary: `${result.summary}${refusedNote}` } : result;
}
