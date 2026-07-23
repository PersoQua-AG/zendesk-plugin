// src/tools/guide/articles.ts
// M5 Guide — articles + article translations. Read + create/update only (NO delete, per PRD §N1).
// Article/translation `body` is HTML in Zendesk; write tools convert Markdown→HTML (markdown flag,
// default from markdown_conversion) unless markdown:false (raw HTML passthrough). Creates reuse the
// neutral generic createEntity (admin-gated via withAdminGuard); updates reuse updateEntity. Every inbound
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
import { createEntity, updateEntity, withAdminGuard } from '../write-helpers.js';
import type { ReadResult } from '../result.js';

// EN + DE are the confirmed first-class Guide locales (PRD §12 item 6). DEFAULT_LOCALE is applied
// when a create/translation omits a locale; any OTHER shape-valid locale string is still accepted
// (the register schema validates shape, not membership — Zendesk 422s a genuinely unknown locale).
export const DEFAULT_LOCALE = 'en-us';

// Locale shape must be validated here too, not solely at the register regex: a direct in-process
// caller could pass a path-segment locale ("../../users/1") that would slot into the locale-keyed
// translation path. Same shape as the register localeSchema — Zendesk 422s a genuinely unknown one.
const LOCALE_SHAPE = /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/i;
function assertLocaleShape(locale: string): void {
  if (!LOCALE_SHAPE.test(locale)) throw new Error(`Invalid translation locale "${locale}" — expected a shape like "en-us" or "de".`);
}

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

const SingleArticleSchema = z.object({ article: ArticleSchema });

export async function getArticle(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { articleId: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  const raw = await client.request<unknown>(`/help_center/articles/${params.articleId}.json`);
  const parsed = SingleArticleSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /help_center/articles/{id} response shape.');
  const { value, flagged } = screenRecordDeep(parsed.data, (key) => `article-${params.articleId}-${key}`, makeScreener(securityLevel));
  const safe = value as { article: Article };
  const entry = cache.save('zendesk_get_article', safe);
  return {
    summary: `Article #${safe.article.id} ${safe.article.title ?? '(untitled)'} [${safe.article.locale ?? '?'}]${flagged ? SCREEN_WARNING : ''}`,
    cacheHandle: entry.handle,
    flagged,
  };
}

const ArticleSearchSchema = z.object({ results: z.array(ArticleSchema) });

export async function searchArticles(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { query: string; locale?: string; perPage?: number },
  securityLevel: SecurityLevel = 'standard',
): Promise<ReadResult> {
  if (params.query.trim() === '') throw new Error('search_articles requires a non-empty query.');
  // Search is offset-style (not CBP). Fetch one defensively-capped page; per_page is clamped to the
  // Zendesk per-page maximum so an oversized result set cannot push an unbounded array into cache.
  const perPage = Math.min(params.perPage ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const parts = [`query=${encodeURIComponent(params.query)}`, `per_page=${perPage}`];
  if (params.locale) parts.push(`locale=${encodeURIComponent(params.locale)}`);
  const raw = await client.request<unknown>(`/help_center/articles/search.json?${parts.join('&')}`);
  const parsed = ArticleSearchSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected /help_center/articles/search response shape.');
  const capped = parsed.data.results.slice(0, perPage);
  const screened = summariseScreened(capped, describeArticle, securityLevel);
  const entry = cache.save('zendesk_search_articles', { results: screened.records });
  // The query echoed in the summary is caller-authored (trusted), not attacker-controlled Zendesk
  // content, so it is safe unscreened; the result lines render from the SCREENED records.
  return {
    summary: `${screened.records.length} article(s) matching "${params.query}":\n${screened.lines.join('\n')}${screened.warning}`,
    cacheHandle: entry.handle,
    flagged: screened.flagged,
  };
}

// User-authored article write fields. Typed precisely (no `any`); body is rendered to HTML before
// delegation. createEntity enforces the required set (title/locale/body) on the built payload.
export interface ArticleCreateFields {
  title?: string;
  body?: string;
  locale?: string;
  draft?: boolean;
}

export function createArticle(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { sectionId: number; fields: ArticleCreateFields; markdown: boolean },
  securityLevel: SecurityLevel = 'standard',
): Promise<{ summary: string; cacheHandle: string }> {
  const locale = params.fields.locale ?? DEFAULT_LOCALE;
  const body = params.fields.body !== undefined ? renderBody(params.fields.body, params.markdown) : undefined;
  const built: Record<string, unknown> = stripUndefined({ ...params.fields, locale, body });
  return createEntity(
    client,
    cache,
    { collection: `/help_center/sections/${params.sectionId}/articles`, key: 'article', toolName: 'zendesk_create_article', resourceLabel: 'article', requiredFields: ['title', 'locale', 'body'], guard: withAdminGuard },
    built,
    securityLevel,
  );
}

export interface ArticleUpdateFields {
  title?: string;
  body?: string;
  draft?: boolean;
}

export function updateArticle(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { articleId: number; fields: ArticleUpdateFields; markdown: boolean },
  securityLevel: SecurityLevel = 'standard',
): Promise<{ summary: string; cacheHandle: string }> {
  const body = params.fields.body !== undefined ? renderBody(params.fields.body, params.markdown) : undefined;
  const built = stripUndefined({ ...params.fields, body });
  return updateEntity(
    client,
    cache,
    { collection: '/help_center/articles', key: 'article', toolName: 'zendesk_update_article', resourceLabel: 'article', guard: withAdminGuard },
    params.articleId,
    built,
    securityLevel,
  );
}

export interface TranslationCreateFields {
  locale?: string;
  title?: string;
  body?: string;
  draft?: boolean;
}

export function createArticleTranslation(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { articleId: number; fields: TranslationCreateFields; markdown: boolean },
  securityLevel: SecurityLevel = 'standard',
): Promise<{ summary: string; cacheHandle: string }> {
  const locale = params.fields.locale ?? DEFAULT_LOCALE;
  assertLocaleShape(locale);
  const body = params.fields.body !== undefined ? renderBody(params.fields.body, params.markdown) : undefined;
  const built: Record<string, unknown> = stripUndefined({ ...params.fields, locale, body });
  return createEntity(
    client,
    cache,
    { collection: `/help_center/articles/${params.articleId}/translations`, key: 'translation', toolName: 'zendesk_create_article_translation', resourceLabel: 'article translation', requiredFields: ['locale', 'title', 'body'], guard: withAdminGuard },
    built,
    securityLevel,
  );
}

export interface TranslationUpdateFields {
  title?: string;
  body?: string;
  draft?: boolean;
}

export function updateArticleTranslation(
  client: ZendeskHttpClient,
  cache: ResponseCache,
  params: { articleId: number; locale: string; fields: TranslationUpdateFields; markdown: boolean },
  securityLevel: SecurityLevel = 'standard',
): Promise<{ summary: string; cacheHandle: string }> {
  assertLocaleShape(params.locale);
  const body = params.fields.body !== undefined ? renderBody(params.fields.body, params.markdown) : undefined;
  const built = stripUndefined({ ...params.fields, body });
  // The translation is keyed by locale in the path: PUT .../articles/{id}/translations/{locale}.
  // updateEntity keys the PUT on its `id` argument (a string here) and percent-encodes it, so the
  // locale slots into the collection tail as one inert segment.
  return updateEntity(
    client,
    cache,
    { collection: `/help_center/articles/${params.articleId}/translations`, key: 'translation', toolName: 'zendesk_update_article_translation', resourceLabel: 'article translation', guard: withAdminGuard },
    params.locale,
    built,
    securityLevel,
  );
}
