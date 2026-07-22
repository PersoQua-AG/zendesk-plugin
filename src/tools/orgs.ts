// src/tools/orgs.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { cbpPageSchema, collectCbp, type CbpPage } from '../client/paginator.js';
import type { SecurityLevel } from '../security/screen.js';
import { makeScreener, screenRecordDeep, summariseScreened, SCREEN_WARNING, type RecordScreen, type Screener } from './screening.js';
import type { ReadResult } from './result.js';

const OrgSchema = z.object({
  id: z.number(),
  name: z.string().nullish(),
  notes: z.string().nullish(),
  details: z.string().nullish(),
  external_id: z.string().nullish(),
  group_id: z.number().nullish(),
  tags: z.array(z.string()).nullish(),
  updated_at: z.string().nullish(),
});
export type Org = z.infer<typeof OrgSchema>;

// An org carries untrusted free text in name/notes/details. Screen field-agnostically so
// every string field reaches the cache neutralized/wrapped; build the line from the safe copy.
function describeOrg(o: Org, screen: Screener): RecordScreen<Org> {
  const { value, flagged } = screenRecordDeep(o, (key) => `org-${o.id}-${key}`, screen);
  const safe = value as Org;
  return { safe, line: `#${safe.id} ${safe.name ?? '(no name)'}`, flagged };
}

const OrgsPageSchema = cbpPageSchema(OrgSchema, 'organizations');

export async function listOrgs(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { pageSize?: number; maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const pageSize = Math.min(params.pageSize ?? 100, 100);
  const cap = params.maxRecords ?? 200;
  const fetchPage = async (cursor: string | null): Promise<CbpPage<Org>> => {
    const parts = [`page[size]=${pageSize}`];
    if (cursor) parts.push(`page[after]=${encodeURIComponent(cursor)}`);
    const raw = await client.request<unknown>(`/organizations.json?${parts.join('&')}`);
    const parsed = OrgsPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unexpected /organizations response shape.');
    return { records: parsed.data.organizations, meta: parsed.data.meta, links: { next: parsed.data.links?.next ?? null } };
  };

  const capped = await collectCbp(fetchPage, cap);
  const screened = summariseScreened(capped, describeOrg, securityLevel);
  const entry = cache.save('zendesk_list_orgs', { organizations: screened.records });
  return {
    summary: `${screened.records.length} organization(s):\n${screened.lines.join('\n')}${screened.warning}`,
    cacheHandle: entry.handle,
    flagged: screened.flagged,
  };
}

const SingleOrgSchema = z.object({ organization: OrgSchema });

export async function getOrg(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { orgId: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const raw = await client.request<unknown>(`/organizations/${params.orgId}.json`);
  const parsed = SingleOrgSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /organizations/{id} response shape.');
  const { value, flagged } = screenRecordDeep(parsed.data, (key) => `org-${params.orgId}-${key}`, makeScreener(securityLevel));
  const safe = value as { organization: Org };
  const entry = cache.save('zendesk_get_org', safe);
  const warning = flagged ? SCREEN_WARNING : '';
  return {
    summary: `Organization #${safe.organization.id} ${safe.organization.name ?? '(no name)'}${warning}`,
    cacheHandle: entry.handle,
    flagged,
  };
}
