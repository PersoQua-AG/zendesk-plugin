// src/tools/orgs.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import type { SecurityLevel } from '../security/screen.js';
import { makeDescribe, makeScreener, screenRecordDeep, SCREEN_WARNING } from './screening.js';
import { listCbp, DEFAULT_LIST_CAP, DEFAULT_MEMBERSHIP_CAP } from './cbp-list.js';
import { updateEntity } from './write-helpers.js';
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

// An org carries untrusted free text in name/notes/details; every string field reaches the
// cache neutralized/wrapped and the line is rendered from the safe copy.
const describeOrg = makeDescribe<Org>('org', (o) => `#${o.id} ${o.name ?? '(no name)'}`);

export async function listOrgs(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { pageSize?: number; maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  return listCbp<Org>({
    client,
    cache,
    securityLevel,
    path: '/organizations.json',
    key: 'organizations',
    schema: OrgSchema,
    describe: describeOrg,
    handle: 'zendesk_list_orgs',
    cap: params.maxRecords ?? DEFAULT_LIST_CAP,
    pageSize: params.pageSize,
    label: (n) => `${n} organization(s)`,
    errorLabel: '/organizations',
  });
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
  // Shares the plain-PUT update tail (strip → empty-guard → PUT → screen → cache), same as users.
  return updateEntity(client, cache, { collection: '/organizations', key: 'organization', toolName: 'zendesk_update_org', resourceLabel: 'organization' }, params.orgId, params.fields, securityLevel);
}

const OrgMembershipSchema = z.object({
  id: z.number(),
  user_id: z.number().nullish(),
  organization_id: z.number().nullish(),
  default: z.boolean().nullish(),
});
type OrgMembership = z.infer<typeof OrgMembershipSchema>;

// Memberships are id-only join records with no free text; screening still runs by
// construction (ids pass through untouched) so the pipeline stays uniform across read tools.
const describeOrgMembership = makeDescribe<OrgMembership>(
  'org-membership',
  (m) => `membership #${m.id} user ${m.user_id ?? '?'} ↔ org ${m.organization_id ?? '?'}`,
);

export async function listOrgMemberships(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { pageSize?: number; maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  return listCbp<OrgMembership>({
    client,
    cache,
    securityLevel,
    path: '/organization_memberships.json',
    key: 'organization_memberships',
    schema: OrgMembershipSchema,
    describe: describeOrgMembership,
    handle: 'zendesk_list_org_memberships',
    cap: params.maxRecords ?? DEFAULT_MEMBERSHIP_CAP,
    pageSize: params.pageSize,
    label: (n) => `${n} organization membership(s)`,
    errorLabel: '/organization_memberships',
  });
}
