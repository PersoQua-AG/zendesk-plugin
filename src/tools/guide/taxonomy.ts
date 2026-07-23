// src/tools/guide/taxonomy.ts
// M5 Guide — taxonomy: sections + categories. Read (list) + create only (NO delete, per PRD §N1).
// Creates reuse the M4 generic createRule (admin-gated by construction) with name+locale required.
// Every inbound record is screened at ingest by construction (name/description fenced; the rest
// passes through the field-agnostic deep screen).
import { z } from 'zod';
import type { ZendeskHttpClient } from '../../client/http-client.js';
import type { ResponseCache } from '../../client/cache.js';
import type { SecurityLevel } from '../../security/screen.js';
import { makeDescribe } from '../screening.js';
import { listCbp, DEFAULT_LIST_CAP } from '../cbp-list.js';
import { stripUndefined } from '../../util/object.js';
import { createRule } from '../business-rules/rules.js';
import { DEFAULT_LOCALE } from './articles.js';
import type { ReadResult } from '../result.js';

const SectionSchema = z.object({
  id: z.number(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  locale: z.string().nullish(),
  category_id: z.number().nullish(),
  position: z.number().nullish(),
  updated_at: z.string().nullish(),
});
type Section = z.infer<typeof SectionSchema>;

// name + description are author-controlled free text (both in ALWAYS_FENCE) → fenced unconditionally.
const describeSection = makeDescribe<Section>('section', (s) => `#${s.id} ${s.name ?? '(unnamed)'} [${s.locale ?? '?'}]`);

export async function listSections(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { pageSize?: number; maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  return listCbp<Section>({
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
