import { z } from 'zod';
// /users/me is a trust boundary: a malformed body must fail loudly, never yield a NaN/undefined
// identity that could collide two users onto one token store.
const meSchema = z.object({ user: z.object({ id: z.number().int().positive() }) });
// Resolves the stable connector identity for a freshly issued Zendesk access token by reading
// /api/v2/users/me.json. The identity is the Zendesk user id (not email) so it is stable across
// profile edits and never carries PII in the store key.
export async function fetchZendeskIdentity(subdomain, accessToken, fetchImpl = fetch) {
    const res = await fetchImpl(`https://${subdomain}.zendesk.com/api/v2/users/me.json`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok)
        throw new Error(`Failed to resolve Zendesk identity (HTTP ${res.status}).`);
    const parsed = meSchema.safeParse(await res.json());
    if (!parsed.success)
        throw new Error('Malformed /users/me response — cannot resolve identity.');
    return `zendesk:${parsed.data.user.id}`;
}
