// src/tools/search.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { screenContent, type SecurityLevel } from '../security/screen.js';
import { paginateCbp, type CbpPage } from '../client/paginator.js';
import type { ReadResult } from './tickets.js';

const SEARCH_HARD_CAP = 1000; // Zendesk /search returns at most 1000 results.

const ResultSchema = z.record(z.unknown());
const SearchPageSchema = z.object({
  results: z.array(ResultSchema),
  count: z.number(),
  next_page: z.string().nullable().nullish(),
});

// Best-effort display text for a heterogeneous search result (ticket/user/org).
function resultText(record: Record<string, unknown>): string {
  for (const key of ['subject', 'title', 'name', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

export async function search(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { query: string; type?: string; maxResults?: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const cap = Math.min(params.maxResults ?? 100, SEARCH_HARD_CAP);
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
  const entry = cache.save('zendesk_search', { results: capped, count });

  let flagged = false;
  for (const record of capped) {
    if (screenContent(resultText(record), 'search-result', securityLevel).flagged) flagged = true;
  }
  const warning = flagged ? ' — WARNING: injection patterns detected in results' : '';
  return { summary: `${capped.length} result(s) (total ${count})${warning}`, cacheHandle: entry.handle, flagged };
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
  const cap = params.maxRecords ?? 1000;
  const encoded = encodeURIComponent(params.query);
  const base = `/search/export.json?query=${encoded}&filter[type]=${encodeURIComponent(params.type)}&page[size]=100`;
  const fetchPage = async (cursor: string | null): Promise<CbpPage<Record<string, unknown>>> => {
    const url = cursor ? `${base}&page[after]=${encodeURIComponent(cursor)}` : base;
    const raw = await client.request<unknown>(url);
    const parsed = ExportPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unexpected /search/export response shape.');
    return { records: parsed.data.results, meta: parsed.data.meta, links: { next: parsed.data.links?.next ?? null } };
  };

  const results: Array<Record<string, unknown>> = [];
  for await (const batch of paginateCbp(fetchPage)) {
    results.push(...batch);
    if (results.length >= cap) break;
  }
  const capped = results.slice(0, cap);
  const entry = cache.save('zendesk_search_export', { results: capped });

  let flagged = false;
  for (const record of capped) {
    if (screenContent(resultText(record), 'search-export-result', securityLevel).flagged) flagged = true;
  }
  const warning = flagged ? ' — WARNING: injection patterns detected in results' : '';
  return { summary: `${capped.length} result(s)${warning}`, cacheHandle: entry.handle, flagged };
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
