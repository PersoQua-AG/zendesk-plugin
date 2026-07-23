// src/tools/analytics/incremental.ts
// Incremental export readers (bulk sync). Two pagination shapes, both distinct from CBP:
//   - cursor-mode  (/incremental/{tickets,users}/cursor.json): after_cursor + end_of_stream
//   - time-mode    (/incremental/ticket_metric_events.json):   end_time + next_page, count<1000
// Every request is metered against the 10 req/min incremental bucket (rateClass:'incremental').
// Records are screened at ingest via summariseScreened before caching.
import { z } from 'zod';
import { makeDescribe, summariseScreened, } from '../screening.js';
// Zendesk incremental export hard per-page maximum. A full page implies "more may exist".
const INCREMENTAL_PAGE_MAX = 1000;
const MAX_INCREMENTAL_PAGES = 10_000;
export const DEFAULT_INCREMENTAL_CAP = 1000; // default record ceiling for the standalone readers
export const MAX_INCREMENTAL_CAP = 10_000; // hard ceiling a caller may raise the cap to
// Cursor-mode: start_time on the first call, then the returned after_cursor, until end_of_stream.
export async function* paginateIncrementalCursor(fetchPage, startTime) {
    let cursor; // undefined only on the first call → send start_time, then cursor
    for (let pages = 0;; pages++) {
        if (pages >= MAX_INCREMENTAL_PAGES) {
            throw new Error(`Incremental cursor export exceeded the ${MAX_INCREMENTAL_PAGES}-page cap.`);
        }
        const page = await fetchPage(cursor === undefined ? { startTime } : { cursor });
        yield page.records;
        if (page.end_of_stream)
            return;
        if (!page.after_cursor) {
            throw new Error('Incremental cursor page reported end_of_stream=false but no after_cursor was returned.');
        }
        cursor = page.after_cursor;
    }
}
// Time-mode: follow end_time as the next start_time until a non-full page (count < 1000) or a null
// next_page/end_time. Guards the poison-pill loop where end_time never advances on a full page.
export async function* paginateIncrementalTime(fetchPage, startTime) {
    let start = startTime;
    for (let pages = 0;; pages++) {
        if (pages >= MAX_INCREMENTAL_PAGES) {
            throw new Error(`Incremental time export exceeded the ${MAX_INCREMENTAL_PAGES}-page cap.`);
        }
        const page = await fetchPage(start);
        yield page.records;
        if (page.count < INCREMENTAL_PAGE_MAX || page.next_page === null || page.end_time === null)
            return;
        if (page.end_time <= start) {
            throw new Error('Incremental time export end_time did not advance — aborting to avoid an infinite loop.');
        }
        start = page.end_time;
    }
}
// Collect incremental pages into a single array, stopping once `cap` records are gathered so a
// reader can never accumulate an unbounded set into memory.
export async function collectIncremental(gen, cap) {
    const all = [];
    for await (const batch of gen) {
        all.push(...batch);
        if (all.length >= cap)
            break;
    }
    return all.slice(0, cap);
}
// ---- Generic cursor reader (paginate cursor-mode + screen) ----
// Validate start_time once for every incremental reader: a positive unix-seconds integer.
function assertStartTime(startTime) {
    if (!Number.isInteger(startTime) || startTime <= 0) {
        throw new Error('Incremental export requires a positive unix-seconds start_time.');
    }
}
export async function fetchIncrementalCursor(config) {
    assertStartTime(config.startTime);
    const pageSchema = z
        .object({ after_cursor: z.string().nullable(), end_of_stream: z.boolean() })
        .extend({ [config.key]: z.array(config.schema) });
    const fetchPage = async (params) => {
        const query = params.cursor !== undefined ? `cursor=${encodeURIComponent(params.cursor)}` : `start_time=${params.startTime}`;
        const raw = await config.client.request(`${config.path}?${query}`, {}, { rateClass: 'incremental' });
        const parsed = pageSchema.safeParse(raw);
        if (!parsed.success)
            throw new Error(`Unexpected ${config.errorLabel} response shape.`);
        const data = parsed.data;
        return {
            records: data[config.key],
            after_cursor: data.after_cursor,
            end_of_stream: data.end_of_stream,
        };
    };
    const collected = await collectIncremental(paginateIncrementalCursor(fetchPage, config.startTime), config.cap);
    return summariseScreened(collected, config.describe, config.securityLevel);
}
// ---- zendesk_incremental_tickets ----
const IncTicketSchema = z.object({
    id: z.number(),
    subject: z.string().nullish(),
    status: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    requester_id: z.number().nullish(),
});
// subject is in ALWAYS_FENCE → wrapped unconditionally by the deep screen.
const describeIncTicket = makeDescribe('inc-ticket', (t) => `#${t.id} [${t.status ?? '?'}] ${t.subject ?? '(no subject)'}`);
export async function incrementalTickets(client, cache, params, securityLevel = 'standard') {
    const cap = Math.min(params.maxRecords ?? DEFAULT_INCREMENTAL_CAP, MAX_INCREMENTAL_CAP);
    const screened = await fetchIncrementalCursor({
        client,
        path: '/incremental/tickets/cursor.json',
        key: 'tickets',
        schema: IncTicketSchema,
        describe: describeIncTicket,
        startTime: params.startTime,
        cap,
        securityLevel,
        errorLabel: '/incremental/tickets',
    });
    const entry = cache.save('zendesk_incremental_tickets', { tickets: screened.records });
    return {
        summary: `${screened.records.length} ticket(s) since ${new Date(params.startTime * 1000).toISOString()}:\n${screened.lines.join('\n')}${screened.warning}`,
        cacheHandle: entry.handle,
        flagged: screened.flagged,
    };
}
// ---- zendesk_incremental_users ----
const IncUserSchema = z.object({
    id: z.number(),
    name: z.string().nullish(),
    email: z.string().nullish(),
    role: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
});
// name is in ALWAYS_FENCE → wrapped unconditionally by the deep screen.
const describeIncUser = makeDescribe('inc-user', (u) => `#${u.id} ${u.name ?? '(no name)'} [${u.role ?? '?'}]`);
export async function incrementalUsers(client, cache, params, securityLevel = 'standard') {
    const cap = Math.min(params.maxRecords ?? DEFAULT_INCREMENTAL_CAP, MAX_INCREMENTAL_CAP);
    const screened = await fetchIncrementalCursor({
        client,
        path: '/incremental/users/cursor.json',
        key: 'users',
        schema: IncUserSchema,
        describe: describeIncUser,
        startTime: params.startTime,
        cap,
        securityLevel,
        errorLabel: '/incremental/users',
    });
    const entry = cache.save('zendesk_incremental_users', { users: screened.records });
    return {
        summary: `${screened.records.length} user(s) since ${new Date(params.startTime * 1000).toISOString()}:\n${screened.lines.join('\n')}${screened.warning}`,
        cacheHandle: entry.handle,
        flagged: screened.flagged,
    };
}
// ---- Generic time reader (paginate time-mode + screen) ----
export async function fetchIncrementalTime(config) {
    assertStartTime(config.startTime);
    const pageSchema = z
        .object({ end_time: z.number().nullable(), next_page: z.string().nullable(), count: z.number() })
        .extend({ [config.key]: z.array(config.schema) });
    const fetchPage = async (startTime) => {
        const raw = await config.client.request(`${config.path}?start_time=${startTime}`, {}, { rateClass: 'incremental' });
        const parsed = pageSchema.safeParse(raw);
        if (!parsed.success)
            throw new Error(`Unexpected ${config.errorLabel} response shape.`);
        const data = parsed.data;
        return {
            records: data[config.key],
            end_time: data.end_time,
            next_page: data.next_page,
            count: data.count,
        };
    };
    const collected = await collectIncremental(paginateIncrementalTime(fetchPage, config.startTime), config.cap);
    return summariseScreened(collected, config.describe, config.securityLevel);
}
// ---- zendesk_ticket_metric_events ----
export const MetricEventSchema = z.object({
    id: z.number(),
    ticket_id: z.number(),
    metric: z.string(),
    instance_id: z.number().nullish(),
    type: z.string(),
    time: z.string(),
});
const describeMetricEvent = makeDescribe('metric-event', (e) => `#${e.id} ticket ${e.ticket_id} ${e.metric}/${e.type} @ ${e.time}`);
export const DEFAULT_EVENTS_CAP = 5000;
export const MAX_EVENTS_CAP = 50_000;
export async function ticketMetricEvents(client, cache, params, securityLevel = 'standard') {
    const cap = Math.min(params.maxRecords ?? DEFAULT_EVENTS_CAP, MAX_EVENTS_CAP);
    const screened = await fetchIncrementalTime({
        client,
        path: '/incremental/ticket_metric_events.json',
        key: 'ticket_metric_events',
        schema: MetricEventSchema,
        describe: describeMetricEvent,
        startTime: params.startTime,
        cap,
        securityLevel,
        errorLabel: '/incremental/ticket_metric_events',
    });
    const entry = cache.save('zendesk_ticket_metric_events', { ticket_metric_events: screened.records });
    return {
        summary: `${screened.records.length} metric event(s) since ${new Date(params.startTime * 1000).toISOString()}:\n${screened.lines.join('\n')}${screened.warning}`,
        cacheHandle: entry.handle,
        flagged: screened.flagged,
    };
}
