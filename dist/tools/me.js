import { z } from 'zod';
const MeResponse = z.object({
    user: z.object({
        id: z.number(),
        name: z.string(),
        email: z.string(),
        role: z.string(),
    }),
});
export async function getMe(client, cache) {
    const raw = await client.request('/users/me.json');
    const parsed = MeResponse.safeParse(raw);
    if (!parsed.success) {
        throw new Error('Unexpected Zendesk /users/me response: missing or malformed "user".');
    }
    const entry = cache.save('zendesk_get_me', parsed.data);
    const { user } = parsed.data;
    return {
        summary: `Authenticated as ${user.name} <${user.email}> — role: ${user.role}`,
        cacheHandle: entry.handle,
    };
}
