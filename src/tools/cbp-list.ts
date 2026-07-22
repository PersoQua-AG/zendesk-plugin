// src/tools/cbp-list.ts
// Shared cursor-based-pagination (CBP) list-and-screen glue for the directory list tools.
// One call per tool: collect capped pages, screen every record, cache the safe copy, return
// a ReadResult. Every inbound record still routes through screenRecordDeep (via
// summariseScreened → the tool's makeDescribe fn), so ingest screening stays enforced by
// construction — this helper cannot serve an unscreened record. Reused by M4–M6 list tools.
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { cbpPageSchema, collectCbp, type CbpPage } from '../client/paginator.js';
import type { SecurityLevel } from '../security/screen.js';
import { summariseScreened, type RecordScreen, type Screener } from './screening.js';
import type { ReadResult } from './result.js';

// Default record ceilings, shared by the tool defaults AND the register-schema `.max()`
// ceilings, so a caller can neither request nor accumulate an unbounded set.
export const DEFAULT_LIST_CAP = 200; // entity lists (orgs / groups / identities)
export const DEFAULT_MEMBERSHIP_CAP = 500; // join-record lists (org / group memberships)
export const MAX_PAGE_SIZE = 100; // Zendesk CBP per-page hard maximum

export interface ListCbpConfig<T extends { id: number }> {
  client: ZendeskHttpClient;
  cache: ResponseCache;
  securityLevel: SecurityLevel;
  path: string; // request path, e.g. '/organizations.json'
  key: string; // envelope array key, e.g. 'organizations'
  schema: z.ZodType<T>; // per-record schema
  describe: (record: T, screen: Screener) => RecordScreen<T>;
  handle: string; // cache tool name, e.g. 'zendesk_list_orgs'
  cap: number; // max records collected
  pageSize?: number; // per-page size (clamped to MAX_PAGE_SIZE)
  label: (count: number) => string; // summary prefix; owns any irregular plural
  errorLabel: string; // shape-error subject, e.g. '/users/{id}/identities'
}

export async function listCbp<T extends { id: number }>(config: ListCbpConfig<T>): Promise<ReadResult> {
  const pageSchema = cbpPageSchema(config.schema, config.key);
  const size = Math.min(config.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);

  const fetchPage = async (cursor: string | null): Promise<CbpPage<T>> => {
    const parts = [`page[size]=${size}`];
    if (cursor) parts.push(`page[after]=${encodeURIComponent(cursor)}`);
    const raw = await config.client.request<unknown>(`${config.path}?${parts.join('&')}`);
    const parsed = pageSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Unexpected ${config.errorLabel} response shape.`);
    // parsed.data is validated; narrow the dynamic envelope key without `any`.
    const data = parsed.data as Record<string, unknown>;
    const meta = data.meta as CbpPage<T>['meta'];
    const links = data.links as { next: string | null } | null | undefined;
    return { records: data[config.key] as T[], meta, links: { next: links?.next ?? null } };
  };

  const capped = await collectCbp(fetchPage, config.cap);
  const screened = summariseScreened(capped, config.describe, config.securityLevel);
  const entry = config.cache.save(config.handle, { [config.key]: screened.records });
  return {
    summary: `${config.label(screened.records.length)}:\n${screened.lines.join('\n')}${screened.warning}`,
    cacheHandle: entry.handle,
    flagged: screened.flagged,
  };
}
