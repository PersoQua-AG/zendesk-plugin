// src/tools/search.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import type { SecurityLevel } from '../security/screen.js';
import { summariseScreened, type RecordScreen, type Screener } from './screening.js';
import { collectCbp, type CbpPage } from '../client/paginator.js';
import type { ReadResult } from './result.js';

export const SEARCH_HARD_CAP = 1000; // Zendesk /search returns at most 1000 results.

const ResultSchema = z.record(z.unknown());
const SearchPageSchema = z.object({
  results: z.array(ResultSchema),
  count: z.number(),
  next_page: z.string().nullable().nullish(),
});

// Untrusted free-text fields across heterogeneous search results (ticket/user/org/group).
const UNTRUSTED_RESULT_FIELDS = ['subject', 'title', 'name', 'description'] as const;

function describeResult(record: Record<string, unknown>, screen: Screener): RecordScreen<Record<string, unknown>> {
  const screened = UNTRUSTED_RESULT_FIELDS.filter(
    (field) => typeof record[field] === 'string' && (record[field] as string).length > 0,
  ).map((field) => ({ field, result: screen(record[field] as string, `search-${field}`) }));
  const safe: Record<string, unknown> = { ...record };
  for (const { field, result } of screened) safe[field] = result.wrapped;
  return {
    safe,
    line: screened[0]?.result.wrapped ?? '',
    flagged: screened.some(({ result }) => result.flagged),
  };
}

export async function search(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { query: string; type?: string; maxRecords?: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const cap = Math.min(params.maxRecords ?? 100, SEARCH_HARD_CAP);
  const query = params.type ? `type:${params.type} ${params.query}` : params.query;
  const encoded = encodeURIComponent(query);

  const results: Array<Record<string, unknown>> = [];
  let count = 0;
  let page = 1;
  while (results.length < cap) {
    const raw = await client.request<unknown>(`/search.json?query=${encoded}&per_page=100&page=${page}`);
    const parsed = SearchPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unexpected /search response shape.');
    count = parsed.data.count;
    results.push(...parsed.data.results);
    if (!parsed.data.next_page || parsed.data.results.length === 0) break;
    page += 1;
  }
  const capped = results.slice(0, cap);
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

export async function searchExport(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { query: string; type: string; maxRecords?: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  // Clamp to the same hard ceiling as `search` so an oversized maxRecords cannot be
  // used to pull an unbounded export into memory.
  const cap = Math.min(params.maxRecords ?? SEARCH_HARD_CAP, SEARCH_HARD_CAP);
  const encoded = encodeURIComponent(params.query);
  const base = `/search/export.json?query=${encoded}&filter[type]=${encodeURIComponent(params.type)}&page[size]=100`;
  const fetchPage = async (cursor: string | null): Promise<CbpPage<Record<string, unknown>>> => {
    const url = cursor ? `${base}&page[after]=${encodeURIComponent(cursor)}` : base;
    const raw = await client.request<unknown>(url);
    const parsed = ExportPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unexpected /search/export response shape.');
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

export async function searchCount(
  client: ZendeskHttpClient,
  params: { query: string },
): Promise<{ summary: string; count: number }> {
  const raw = await client.request<unknown>(`/search/count.json?query=${encodeURIComponent(params.query)}`);
  const parsed = CountSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /search/count response shape.');
  return { summary: `${parsed.data.count} matching record(s).`, count: parsed.data.count };
}
