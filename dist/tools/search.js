// src/tools/search.ts
import { z } from 'zod';
import { screenRecordDeep, summariseScreened } from './screening.js';
import { collectCbp, collectOffset } from '../client/paginator.js';
export const SEARCH_HARD_CAP = 1000; // Zendesk /search returns at most 1000 results.
const ResultSchema = z.record(z.unknown());
const SearchPageSchema = z.object({
    results: z.array(ResultSchema),
    count: z.number(),
    next_page: z.string().nullable().nullish(),
});
// Search returns heterogeneous records (ticket/user/org/group) whose untrusted free-text
// lives in different fields per type (subject/title/name/description, but also notes,
// details, raw_subject, …). Screen field-agnostically so no result field reaches the cache
// — and thus a later zendesk_query replay — carrying a raw payload.
function describeResult(record, screen) {
    const { value, flagged } = screenRecordDeep(record, (key) => `search-${key}`, screen);
    return { safe: value, line: '', flagged };
}
export async function search(client, cache, params, securityLevel = 'standard') {
    const cap = Math.min(params.maxRecords ?? 100, SEARCH_HARD_CAP);
    const query = params.type ? `type:${params.type} ${params.query}` : params.query;
    const encoded = encodeURIComponent(query);
    let count = 0;
    const capped = await collectOffset(async (page) => {
        const raw = await client.request(`/search.json?query=${encoded}&per_page=100&page=${page}`);
        const parsed = SearchPageSchema.safeParse(raw);
        if (!parsed.success)
            throw new Error('Unexpected /search response shape.');
        count = parsed.data.count;
        return { records: parsed.data.results, nextPage: parsed.data.next_page ?? null };
    }, cap);
    const screened = summariseScreened(capped, describeResult, securityLevel);
    const entry = cache.save('zendesk_search', { results: screened.records, count });
    return {
        summary: `${screened.records.length} result(s) (total ${count})${screened.warning}`,
        cacheHandle: entry.handle,
        flagged: screened.flagged,
    };
}
const ExportPageSchema = z.object({
    results: z.array(ResultSchema),
    meta: z.object({ has_more: z.boolean(), after_cursor: z.string().nullable() }),
    links: z.object({ next: z.string().nullable() }).nullish(),
});
export async function searchExport(client, cache, params, securityLevel = 'standard') {
    // Clamp to the same hard ceiling as `search` so an oversized maxRecords cannot be
    // used to pull an unbounded export into memory.
    const cap = Math.min(params.maxRecords ?? SEARCH_HARD_CAP, SEARCH_HARD_CAP);
    const encoded = encodeURIComponent(params.query);
    const base = `/search/export.json?query=${encoded}&filter[type]=${encodeURIComponent(params.type)}&page[size]=100`;
    const fetchPage = async (cursor) => {
        const url = cursor ? `${base}&page[after]=${encodeURIComponent(cursor)}` : base;
        const raw = await client.request(url);
        const parsed = ExportPageSchema.safeParse(raw);
        if (!parsed.success)
            throw new Error('Unexpected /search/export response shape.');
        return { records: parsed.data.results, meta: parsed.data.meta, links: { next: parsed.data.links?.next ?? null } };
    };
    const capped = await collectCbp(fetchPage, cap);
    const screened = summariseScreened(capped, describeResult, securityLevel);
    const entry = cache.save('zendesk_search_export', { results: screened.records });
    return {
        summary: `${screened.records.length} result(s)${screened.warning}`,
        cacheHandle: entry.handle,
        flagged: screened.flagged,
    };
}
const CountSchema = z.object({ count: z.number() });
export async function searchCount(client, params) {
    const raw = await client.request(`/search/count.json?query=${encodeURIComponent(params.query)}`);
    const parsed = CountSchema.safeParse(raw);
    if (!parsed.success)
        throw new Error('Unexpected /search/count response shape.');
    return { summary: `${parsed.data.count} matching record(s).`, count: parsed.data.count };
}
