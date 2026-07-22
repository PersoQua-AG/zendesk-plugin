// src/tools/search.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { screenContent, type SecurityLevel } from '../security/screen.js';
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
