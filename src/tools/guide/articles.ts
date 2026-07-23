// src/tools/guide/articles.ts
// M5 Guide — articles + article translations. Read + create/update only (NO delete, per PRD §N1).
// Article/translation `body` is HTML in Zendesk; write tools convert Markdown→HTML (markdown flag,
// default from markdown_conversion) unless markdown:false (raw HTML passthrough). Creates reuse the
// M4 generic createRule (admin-gated by construction); updates reuse updateEntity. Every inbound
// record is screened at ingest by construction (title/body fenced; the rest passes through the
// field-agnostic deep screen).
import { z } from 'zod';
import type { ZendeskHttpClient } from '../../client/http-client.js';
import type { ResponseCache } from '../../client/cache.js';
import type { SecurityLevel } from '../../security/screen.js';
import { makeScreener, screenRecordDeep, summariseScreened, makeDescribe, SCREEN_WARNING } from '../screening.js';
import { listCbp, DEFAULT_LIST_CAP, MAX_PAGE_SIZE } from '../cbp-list.js';
import { markdownToHtml } from '../../util/markdown.js';
import { stripUndefined } from '../../util/object.js';
import { createRule, withAdminGuard } from '../business-rules/rules.js';
import { updateEntity } from '../write-helpers.js';
import type { ReadResult } from '../result.js';

// EN + DE are the confirmed first-class Guide locales (PRD §12 item 6). DEFAULT_LOCALE is applied
// when a create/translation omits a locale; any OTHER shape-valid locale string is still accepted
// (the register schema validates shape, not membership — Zendesk 422s a genuinely unknown locale).
export const DEFAULT_LOCALE = 'en-us';
export const GUIDE_LOCALES = ['en-us', 'de'] as const;

const ArticleSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  body: z.string().nullish(),
  locale: z.string().nullish(),
  section_id: z.number().nullish(),
  author_id: z.number().nullish(),
  draft: z.boolean().nullish(),
  html_url: z.string().nullish(),
  updated_at: z.string().nullish(),
});
export type Article = z.infer<typeof ArticleSchema>;

// An article's untrusted free text is its title + body (HTML, author-controlled and rendered on
// read). Both keys are in ALWAYS_FENCE, so the deep screen wraps them unconditionally; the line
// renders from the SAFE copy so no raw payload leaks into the summary.
const describeArticle = makeDescribe<Article>('article', (a) => `#${a.id} ${a.title ?? '(untitled)'}${a.draft ? ' (draft)' : ''} [${a.locale ?? '?'}]`);

// Article/translation body is HTML in Zendesk. Convert Markdown→HTML when markdown is on (per-call
// flag defaulting to the global markdown_conversion). markdown:false → raw HTML passthrough.
function renderBody(body: string, useMarkdown: boolean): string {
  return useMarkdown ? markdownToHtml(body) : body;
}

export async function listArticles(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { pageSize?: number; maxRecords?: number } = {},
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  return listCbp<Article>({
    client,
    cache,
    securityLevel,
    path: '/help_center/articles.json',
    key: 'articles',
    schema: ArticleSchema,
    describe: describeArticle,
    handle: 'zendesk_list_articles',
    cap: Math.min(params.maxRecords ?? DEFAULT_LIST_CAP, DEFAULT_LIST_CAP),
    pageSize: params.pageSize,
    label: (n) => `${n} article(s)`,
    errorLabel: '/help_center/articles',
  });
}
