// src/tools/orgs.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { cbpPageSchema, collectCbp, type CbpPage } from '../client/paginator.js';
import type { SecurityLevel } from '../security/screen.js';
import { makeScreener, screenRecordDeep, summariseScreened, SCREEN_WARNING, type RecordScreen, type Screener } from './screening.js';
import { stripUndefined } from '../util/object.js';
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
  // `name` is always fenced in the cache; show a short safe indicator in the summary rather
  // than the raw wrapped envelope (see getUser). The cached payload keeps the fenced value.
  const displayName = flagged ? '[flagged]' : parsed.data.organization.name ?? '(no name)';
  return {
    summary: `Organization #${safe.organization.id} ${displayName}${warning}`,
    cacheHandle: entry.handle,
    flagged,
  };
}

export interface OrgWriteFields {
  name?: string;
  notes?: string;
  details?: string;
  external_id?: string;
  group_id?: number;
  tags?: string[];
}

export async function upsertOrg(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { fields: OrgWriteFields },
  securityLevel: SecurityLevel = 'standard',
): Promise<{ summary: string; cacheHandle: string }> {
  const f = params.fields;
  // create_or_update matches an existing org by name (or external_id); a name is required.
  if (!f.name || f.name.trim() === '') throw new Error('upsert_org requires a name.');
  const raw = await client.request<unknown>('/organizations/create_or_update.json', {
    method: 'POST',
    body: JSON.stringify({ organization: f }),
  });
  const parsed = SingleOrgSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /organizations/create_or_update response shape.');
  const { value: safe, flagged } = screenRecordDeep(parsed.data, (key) => `upsert-org-${parsed.data.organization.id}-${key}`, makeScreener(securityLevel));
  const entry = cache.save('zendesk_upsert_org', safe);
  return { summary: `Upserted organization #${parsed.data.organization.id}${flagged ? SCREEN_WARNING : ''}`, cacheHandle: entry.handle };
}

export async function updateOrg(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { orgId: number; fields: OrgWriteFields },
  securityLevel: SecurityLevel = 'standard',
): Promise<{ summary: string; cacheHandle: string }> {
  // Strip undefined-valued keys before the guard so {name: undefined} cannot pass the
  // key-count check and fire an empty {"organization":{}} PUT (see updateUser).
  const defined = stripUndefined(params.fields);
  if (Object.keys(defined).length === 0) throw new Error('update_org requires at least one field to change.');
  const raw = await client.request<unknown>(`/organizations/${params.orgId}.json`, {
    method: 'PUT',
    body: JSON.stringify({ organization: defined }),
  });
  const parsed = SingleOrgSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /organizations/{id} update response shape.');
  const { value: safe, flagged } = screenRecordDeep(parsed.data, (key) => `update-org-${params.orgId}-${key}`, makeScreener(securityLevel));
  const entry = cache.save('zendesk_update_org', safe);
  return { summary: `Updated organization #${params.orgId}${flagged ? SCREEN_WARNING : ''}`, cacheHandle: entry.handle };
}

const OrgMembershipSchema = z.object({
  id: z.number(),
  user_id: z.number().nullish(),
  organization_id: z.number().nullish(),
  default: z.boolean().nullish(),
});
type OrgMembership = z.infer<typeof OrgMembershipSchema>;

const OrgMembershipsPageSchema = cbpPageSchema(OrgMembershipSchema, 'organization_memberships');

// Memberships are id-only join records with no free text; screenRecordDeep still runs by
// construction (ids pass through untouched) so the pipeline stays uniform across read tools.
function describeOrgMembership(m: OrgMembership, screen: Screener): RecordScreen<OrgMembership> {
  const { value, flagged } = screenRecordDeep(m, (key) => `org-membership-${m.id}-${key}`, screen);
  const safe = value as OrgMembership;
  return { safe, line: `membership #${safe.id} user ${safe.user_id ?? '?'} ↔ org ${safe.organization_id ?? '?'}`, flagged };
}

export async function listOrgMemberships(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const cap = params.maxRecords ?? 500;
  const fetchPage = async (cursor: string | null): Promise<CbpPage<OrgMembership>> => {
    const parts = ['page[size]=100'];
    if (cursor) parts.push(`page[after]=${encodeURIComponent(cursor)}`);
    const raw = await client.request<unknown>(`/organization_memberships.json?${parts.join('&')}`);
    const parsed = OrgMembershipsPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unexpected /organization_memberships response shape.');
    return { records: parsed.data.organization_memberships, meta: parsed.data.meta, links: { next: parsed.data.links?.next ?? null } };
  };

  const capped = await collectCbp(fetchPage, cap);
  const screened = summariseScreened(capped, describeOrgMembership, securityLevel);
  const entry = cache.save('zendesk_list_org_memberships', { organization_memberships: screened.records });
  return {
    summary: `${screened.records.length} organization membership(s):\n${screened.lines.join('\n')}${screened.warning}`,
    cacheHandle: entry.handle,
    flagged: screened.flagged,
  };
}
