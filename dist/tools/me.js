import { z } from 'zod';
import { makeScreener, screenRecordDeep, SCREEN_WARNING } from './screening.js';
const MeResponse = z.object({
    user: z.object({
        id: z.number(),
        name: z.string(),
        email: z.string(),
        role: z.string(),
    }),
});
export async function getMe(client, cache, securityLevel = 'standard') {
    const raw = await client.request('/users/me.json');
    const parsed = MeResponse.safeParse(raw);
    if (!parsed.success) {
        throw new Error('Unexpected Zendesk /users/me response: missing or malformed "user".');
    }
    const { value, flagged } = screenRecordDeep(parsed.data, (key) => `me-${key}`, makeScreener(securityLevel));
    const safe = value;
    const entry = cache.save('zendesk_get_me', safe);
    const warning = flagged ? SCREEN_WARNING : '';
    // name/email are free text — render from the FENCED `safe.user`, never raw (parity with
    // getUser). id is numeric and role a server-controlled enum, so both read from raw.
    const fenced = safe.user;
    const { user } = parsed.data;
    return {
        summary: `Authenticated as ${fenced.name} <${fenced.email}> — role: ${user.role}${warning}`,
        cacheHandle: entry.handle,
    };
}
