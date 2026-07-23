// src/tools/groups.ts
import { z } from 'zod';
import { makeDescribe } from './screening.js';
import { listCbp, DEFAULT_LIST_CAP, DEFAULT_MEMBERSHIP_CAP } from './cbp-list.js';
const GroupSchema = z.object({
    id: z.number(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    default: z.boolean().nullish(),
    deleted: z.boolean().nullish(),
});
// A group carries untrusted free text in name/description; both reach the cache
// neutralized/wrapped and the line is rendered from the safe copy.
const describeGroup = makeDescribe('group', (g) => `#${g.id} ${g.name ?? '(no name)'}`);
export async function listGroups(client, cache, params = {}, securityLevel = 'standard') {
    return listCbp({
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
const describeGroupMembership = makeDescribe('group-membership', (m) => `membership #${m.id} user ${m.user_id ?? '?'} ↔ group ${m.group_id ?? '?'}`);
export async function listGroupMemberships(client, cache, params = {}, securityLevel = 'standard') {
    return listCbp({
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
