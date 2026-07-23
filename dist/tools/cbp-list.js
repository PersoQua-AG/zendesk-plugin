import { cbpPageSchema, collectCbp } from '../client/paginator.js';
import { summariseScreened } from './screening.js';
// Default record ceilings, shared by the tool defaults AND the register-schema `.max()`
// ceilings, so a caller can neither request nor accumulate an unbounded set.
export const DEFAULT_LIST_CAP = 200; // entity lists (orgs / groups / identities)
export const DEFAULT_MEMBERSHIP_CAP = 500; // join-record lists (org / group memberships)
export const MAX_PAGE_SIZE = 100; // Zendesk CBP per-page hard maximum
export async function listCbp(config) {
    const pageSchema = cbpPageSchema(config.schema, config.key);
    const size = Math.min(config.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    const fetchPage = async (cursor) => {
        const parts = [`page[size]=${size}`];
        if (cursor)
            parts.push(`page[after]=${encodeURIComponent(cursor)}`);
        const raw = await config.client.request(`${config.path}?${parts.join('&')}`);
        const parsed = pageSchema.safeParse(raw);
        if (!parsed.success)
            throw new Error(`Unexpected ${config.errorLabel} response shape.`);
        // parsed.data is validated; narrow the dynamic envelope key without `any`.
        const data = parsed.data;
        const meta = data.meta;
        const links = data.links;
        return { records: data[config.key], meta, links: { next: links?.next ?? null } };
    };
    const capped = await collectCbp(fetchPage, config.cap);
    const screened = summariseScreened(capped, config.describe, config.securityLevel);
    const entry = config.cache.save(config.handle, { [config.key]: screened.records });
    const n = screened.records.length;
    const summary = config.summary ? config.summary(n) : `${config.label(n)}:\n${screened.lines.join('\n')}`;
    return {
        summary: `${summary}${screened.warning}`,
        cacheHandle: entry.handle,
        flagged: screened.flagged,
    };
}
