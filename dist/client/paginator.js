import { z } from 'zod';
const MAX_PAGES = 10_000;
// Retype the cursor-based-pagination (CBP) page envelope — a `<key>` array plus the
// meta/links wrapper — once, instead of redeclaring it at each tool's call site.
export function cbpPageSchema(itemSchema, key) {
    return z
        .object({
        meta: z.object({ has_more: z.boolean(), after_cursor: z.string().nullable() }),
        links: z.object({ next: z.string().nullable() }).nullish(),
    })
        .extend({ [key]: z.array(itemSchema) });
}
export async function* paginateCbp(fetchPage) {
    let cursor = null;
    let hasMore = true;
    let pages = 0;
    while (hasMore) {
        if (pages >= MAX_PAGES) {
            throw new Error(`CBP pagination exceeded the ${MAX_PAGES}-page cap — aborting to avoid an infinite loop`);
        }
        const pageResult = await fetchPage(cursor);
        pages += 1;
        yield pageResult.records;
        hasMore = pageResult.meta.has_more;
        cursor = pageResult.meta.after_cursor;
        if (hasMore && !cursor) {
            throw new Error('CBP page reported has_more=true but no after_cursor was returned');
        }
    }
}
// Collect CBP pages into a single array, stopping once `cap` records are gathered so
// a tool can never accumulate an unbounded result set into memory.
export async function collectCbp(fetchPage, cap) {
    const all = [];
    for await (const batch of paginateCbp(fetchPage)) {
        all.push(...batch);
        if (all.length >= cap)
            break;
    }
    return all.slice(0, cap);
}
// Offset-pagination twin of collectCbp for the /search and /users/search subsystems:
// walk `?page=1,2,…` until a page reports no next_page (or comes back empty), capping the
// accumulated set so an oversized maxRecords can never pull an unbounded result into memory.
export async function collectOffset(fetchPage, cap) {
    const all = [];
    let page = 1;
    while (all.length < cap) {
        const { records, nextPage } = await fetchPage(page);
        all.push(...records);
        if (!nextPage || records.length === 0)
            break;
        page += 1;
    }
    return all.slice(0, cap);
}
