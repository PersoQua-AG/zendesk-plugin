// src/tools/groups.ts
import { z } from 'zod';
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import type { SecurityLevel } from '../security/screen.js';
import { makeDescribe } from './screening.js';
import { listCbp, DEFAULT_LIST_CAP, DEFAULT_MEMBERSHIP_CAP } from './cbp-list.js';
import type { ReadResult } from './result.js';

const GroupSchema = z.object({
  id: z.number(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  default: z.boolean().nullish(),
  deleted: z.boolean().nullish(),
});
type Group = z.infer<typeof GroupSchema>;

// A group carries untrusted free text in name/description; both reach the cache
// neutralized/wrapped and the line is rendered from the safe copy.
const describeGroup = makeDescribe<Group>('group', (g) => `#${g.id} ${g.name ?? '(no name)'}`);

export async function listGroups(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { pageSize?: number; maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  return listCbp<Group>({
    client,
    cache,
    securityLevel,
    path: '/groups.json',
    key: 'groups',
    schema: GroupSchema,
    describe: describeGroup,
    handle: 'zendesk_list_groups',
    cap: params.maxRecords ?? DEFAULT_LIST_CAP,
    pageSize: params.pageSize,
    label: (n) => `${n} group(s)`,
    errorLabel: '/groups',
  });
}

const GroupMembershipSchema = z.object({
  id: z.number(),
  user_id: z.number().nullish(),
  group_id: z.number().nullish(),
  default: z.boolean().nullish(),
});
type GroupMembership = z.infer<typeof GroupMembershipSchema>;

const describeGroupMembership = makeDescribe<GroupMembership>(
  'group-membership',
  (m) => `membership #${m.id} user ${m.user_id ?? '?'} ↔ group ${m.group_id ?? '?'}`,
);

export async function listGroupMemberships(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { pageSize?: number; maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  return listCbp<GroupMembership>({
    client,
    cache,
    securityLevel,
    path: '/group_memberships.json',
    key: 'group_memberships',
    schema: GroupMembershipSchema,
    describe: describeGroupMembership,
    handle: 'zendesk_list_group_memberships',
    cap: params.maxRecords ?? DEFAULT_MEMBERSHIP_CAP,
    pageSize: params.pageSize,
    label: (n) => `${n} group membership(s)`,
    errorLabel: '/group_memberships',
  });
}
