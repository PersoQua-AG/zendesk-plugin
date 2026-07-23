// src/tools/guide/taxonomy.ts
// M5 Guide — taxonomy: sections + categories. Read (list) + create only (NO delete, per PRD §N1).
// Creates reuse the neutral generic createEntity (admin-gated via withAdminGuard) with name+locale required.
// Every inbound record is screened at ingest by construction (name/description fenced; the rest
// passes through the field-agnostic deep screen).
import { z } from 'zod';
import { makeDescribe } from '../screening.js';
import { listCbp, DEFAULT_LIST_CAP } from '../cbp-list.js';
import { stripUndefined } from '../../util/object.js';
import { createEntity, withAdminGuard } from '../write-helpers.js';
import { DEFAULT_LOCALE } from './articles.js';
const SectionSchema = z.object({
    id: z.number(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    locale: z.string().nullish(),
    category_id: z.number().nullish(),
    position: z.number().nullish(),
    updated_at: z.string().nullish(),
});
// name + description are author-controlled free text (both in ALWAYS_FENCE) → fenced unconditionally.
const describeSection = makeDescribe('section', (s) => `#${s.id} ${s.name ?? '(unnamed)'} [${s.locale ?? '?'}]`);
export async function listSections(client, cache, params = {}, securityLevel = 'standard') {
    return listCbp({
        client,
        cache,
        securityLevel,
        path: '/help_center/sections.json',
        key: 'sections',
        schema: SectionSchema,
        describe: describeSection,
        handle: 'zendesk_list_sections',
        cap: Math.min(params.maxRecords ?? DEFAULT_LIST_CAP, DEFAULT_LIST_CAP),
        pageSize: params.pageSize,
        label: (n) => `${n} section(s)`,
        errorLabel: '/help_center/sections',
    });
}
const CategorySchema = z.object({
    id: z.number(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    locale: z.string().nullish(),
    position: z.number().nullish(),
    updated_at: z.string().nullish(),
});
const describeCategory = makeDescribe('category', (c) => `#${c.id} ${c.name ?? '(unnamed)'} [${c.locale ?? '?'}]`);
export async function listCategories(client, cache, params = {}, securityLevel = 'standard') {
    return listCbp({
        client,
        cache,
        securityLevel,
        path: '/help_center/categories.json',
        key: 'categories',
        schema: CategorySchema,
        describe: describeCategory,
        handle: 'zendesk_list_categories',
        cap: Math.min(params.maxRecords ?? DEFAULT_LIST_CAP, DEFAULT_LIST_CAP),
        pageSize: params.pageSize,
        label: (n) => `${n} category(ies)`,
        errorLabel: '/help_center/categories',
    });
}
export function createSection(client, cache, params, securityLevel = 'standard') {
    const locale = params.fields.locale ?? DEFAULT_LOCALE;
    const built = stripUndefined({ ...params.fields, locale });
    return createEntity(client, cache, { collection: `/help_center/categories/${params.categoryId}/sections`, key: 'section', toolName: 'zendesk_create_section', resourceLabel: 'section', requiredFields: ['name', 'locale'], guard: withAdminGuard }, built, securityLevel);
}
export function createCategory(client, cache, params, securityLevel = 'standard') {
    const locale = params.fields.locale ?? DEFAULT_LOCALE;
    const built = stripUndefined({ ...params.fields, locale });
    return createEntity(client, cache, { collection: '/help_center/categories', key: 'category', toolName: 'zendesk_create_category', resourceLabel: 'category', requiredFields: ['name', 'locale'], guard: withAdminGuard }, built, securityLevel);
}
