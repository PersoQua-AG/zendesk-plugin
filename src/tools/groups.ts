// src/tools/groups.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import { cbpPageSchema, collectCbp, type CbpPage } from '../client/paginator.js';
import type { SecurityLevel } from '../security/screen.js';
import { screenRecordDeep, summariseScreened, type RecordScreen, type Screener } from './screening.js';
import type { ReadResult } from './result.js';

const GroupSchema = z.object({
  id: z.number(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  default: z.boolean().nullish(),
  deleted: z.boolean().nullish(),
});
type Group = z.infer<typeof GroupSchema>;

const GroupsPageSchema = cbpPageSchema(GroupSchema, 'groups');

// A group carries untrusted free text in name/description. Screen field-agnostically so both
// reach the cache neutralized/wrapped; build the line from the safe copy.
function describeGroup(g: Group, screen: Screener): RecordScreen<Group> {
  const { value, flagged } = screenRecordDeep(g, (key) => `group-${g.id}-${key}`, screen);
  const safe = value as Group;
  return { safe, line: `#${safe.id} ${safe.name ?? '(no name)'}`, flagged };
}

export async function listGroups(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const cap = params.maxRecords ?? 200;
  const fetchPage = async (cursor: string | null): Promise<CbpPage<Group>> => {
    const parts = ['page[size]=100'];
    if (cursor) parts.push(`page[after]=${encodeURIComponent(cursor)}`);
    const raw = await client.request<unknown>(`/groups.json?${parts.join('&')}`);
    const parsed = GroupsPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unexpected /groups response shape.');
    return { records: parsed.data.groups, meta: parsed.data.meta, links: { next: parsed.data.links?.next ?? null } };
  };

  const capped = await collectCbp(fetchPage, cap);
  const screened = summariseScreened(capped, describeGroup, securityLevel);
  const entry = cache.save('zendesk_list_groups', { groups: screened.records });
  return {
    summary: `${screened.records.length} group(s):\n${screened.lines.join('\n')}${screened.warning}`,
    cacheHandle: entry.handle,
    flagged: screened.flagged,
  };
}

const GroupMembershipSchema = z.object({
  id: z.number(),
  user_id: z.number().nullish(),
  group_id: z.number().nullish(),
  default: z.boolean().nullish(),
});
type GroupMembership = z.infer<typeof GroupMembershipSchema>;

const GroupMembershipsPageSchema = cbpPageSchema(GroupMembershipSchema, 'group_memberships');

function describeGroupMembership(m: GroupMembership, screen: Screener): RecordScreen<GroupMembership> {
  const { value, flagged } = screenRecordDeep(m, (key) => `group-membership-${m.id}-${key}`, screen);
  const safe = value as GroupMembership;
  return { safe, line: `membership #${safe.id} user ${safe.user_id ?? '?'} ↔ group ${safe.group_id ?? '?'}`, flagged };
}

export async function listGroupMemberships(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const cap = params.maxRecords ?? 500;
  const fetchPage = async (cursor: string | null): Promise<CbpPage<GroupMembership>> => {
    const parts = ['page[size]=100'];
    if (cursor) parts.push(`page[after]=${encodeURIComponent(cursor)}`);
    const raw = await client.request<unknown>(`/group_memberships.json?${parts.join('&')}`);
    const parsed = GroupMembershipsPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unexpected /group_memberships response shape.');
    return { records: parsed.data.group_memberships, meta: parsed.data.meta, links: { next: parsed.data.links?.next ?? null } };
  };

  const capped = await collectCbp(fetchPage, cap);
  const screened = summariseScreened(capped, describeGroupMembership, securityLevel);
  const entry = cache.save('zendesk_list_group_memberships', { group_memberships: screened.records });
  return {
    summary: `${screened.records.length} group membership(s):\n${screened.lines.join('\n')}${screened.warning}`,
    cacheHandle: entry.handle,
    flagged: screened.flagged,
  };
}
