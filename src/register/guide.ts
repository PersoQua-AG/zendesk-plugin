// src/register/guide.ts — Help Center / Guide: articles, translations, sections, categories.
// Read + create/update only (no delete, per PRD §N1). Article/translation bodies convert
// Markdown→HTML (per-call markdown flag defaulting to the global markdown_conversion). Guide
// writes are admin-gated (403 → actionable ZendeskPermissionError inside createRule/updateEntity).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { okWithHandle } from '../tools/result.js';
import {
  listArticles,
  getArticle,
  searchArticles,
  createArticle,
  updateArticle,
  createArticleTranslation,
  updateArticleTranslation,
} from '../tools/guide/articles.js';
import { listSections, listCategories, createSection, createCategory } from '../tools/guide/taxonomy.js';
import { DEFAULT_LIST_CAP, MAX_PAGE_SIZE } from '../tools/cbp-list.js';
import type { ToolContext } from './context.js';

const pageSizeSchema = z.number().int().positive().max(MAX_PAGE_SIZE).optional();
const listMaxRecordsSchema = z.number().int().positive().max(DEFAULT_LIST_CAP).optional();
const idSchema = z.number().int().positive();
// EN + DE are first-class (PRD §12 item 6); any shape-valid locale string is accepted. Membership
// is NOT constrained — Zendesk 422s a genuinely unknown locale.
const localeSchema = z.string().regex(/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/i, 'locale must look like "en-us" or "de"');

export function registerGuideTools(server: McpServer, ctx: ToolContext): void {
  const { httpClient, cache, securityLevel, markdownDefault } = ctx;

  server.registerTool(
    'zendesk_list_articles',
    { description: 'List Help Center articles (cursor-paginated, screened).', inputSchema: { pageSize: pageSizeSchema, maxRecords: listMaxRecordsSchema } },
    async (args) => okWithHandle(await listArticles(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_get_article',
    { description: 'Get one Help Center article by id (screened).', inputSchema: { articleId: idSchema } },
    async ({ articleId }) => okWithHandle(await getArticle(httpClient, cache, { articleId }, securityLevel)),
  );

  server.registerTool(
    'zendesk_search_articles',
    {
      description: 'Search Help Center articles by query (one capped page, screened).',
      inputSchema: { query: z.string().min(1), locale: localeSchema.optional(), perPage: pageSizeSchema },
    },
    async (args) => okWithHandle(await searchArticles(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_create_article',
    {
      description:
        'Create a Help Center article in a section (Guide manager/admin only). Requires title + body; locale defaults to en-us (en-us + de are first-class, any valid locale accepted). Body is converted Markdown→HTML unless markdown:false (pass raw HTML for rich content — tables/images/nested lists need markdown:false). Confirm the change in-conversation before calling.',
      inputSchema: { sectionId: idSchema, title: z.string().min(1), body: z.string().min(1), locale: localeSchema.optional(), draft: z.boolean().optional(), markdown: z.boolean().optional() },
    },
    async ({ sectionId, markdown, ...fields }) => okWithHandle(await createArticle(httpClient, cache, { sectionId, fields, markdown: markdown ?? markdownDefault }, securityLevel)),
  );

  server.registerTool(
    'zendesk_update_article',
    {
      description:
        'Update a Help Center article by id (Guide manager/admin only). At least one of title/body/draft required. Body is converted Markdown→HTML unless markdown:false. Confirm the change in-conversation before calling.',
      inputSchema: { articleId: idSchema, title: z.string().min(1).optional(), body: z.string().min(1).optional(), draft: z.boolean().optional(), markdown: z.boolean().optional() },
    },
    async ({ articleId, markdown, ...fields }) => okWithHandle(await updateArticle(httpClient, cache, { articleId, fields, markdown: markdown ?? markdownDefault }, securityLevel)),
  );

  server.registerTool(
    'zendesk_create_article_translation',
    {
      description:
        'Create a translation for an article (Guide manager/admin only). Requires locale + title + body; locale defaults to en-us (typically pass the target locale, e.g. de). Body Markdown→HTML unless markdown:false. Confirm the change in-conversation before calling.',
      inputSchema: { articleId: idSchema, locale: localeSchema.optional(), title: z.string().min(1), body: z.string().min(1), draft: z.boolean().optional(), markdown: z.boolean().optional() },
    },
    async ({ articleId, markdown, ...fields }) => okWithHandle(await createArticleTranslation(httpClient, cache, { articleId, fields, markdown: markdown ?? markdownDefault }, securityLevel)),
  );

  server.registerTool(
    'zendesk_update_article_translation',
    {
      description:
        'Update an article translation for a given locale (Guide manager/admin only). At least one of title/body/draft required. Body Markdown→HTML unless markdown:false. Confirm the change in-conversation before calling.',
      inputSchema: { articleId: idSchema, locale: localeSchema, title: z.string().min(1).optional(), body: z.string().min(1).optional(), draft: z.boolean().optional(), markdown: z.boolean().optional() },
    },
    async ({ articleId, locale, markdown, ...fields }) => okWithHandle(await updateArticleTranslation(httpClient, cache, { articleId, locale, fields, markdown: markdown ?? markdownDefault }, securityLevel)),
  );

  server.registerTool(
    'zendesk_list_sections',
    { description: 'List Help Center sections (cursor-paginated, screened).', inputSchema: { pageSize: pageSizeSchema, maxRecords: listMaxRecordsSchema } },
    async (args) => okWithHandle(await listSections(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_list_categories',
    { description: 'List Help Center categories (cursor-paginated, screened).', inputSchema: { pageSize: pageSizeSchema, maxRecords: listMaxRecordsSchema } },
    async (args) => okWithHandle(await listCategories(httpClient, cache, args, securityLevel)),
  );

  server.registerTool(
    'zendesk_create_section',
    {
      description: 'Create a Help Center section in a category (Guide manager/admin only). Requires a name; locale defaults to en-us. Confirm the change in-conversation before calling.',
      inputSchema: { categoryId: idSchema, name: z.string().min(1), locale: localeSchema.optional(), description: z.string().optional(), position: z.number().int().nonnegative().optional() },
    },
    async ({ categoryId, ...fields }) => okWithHandle(await createSection(httpClient, cache, { categoryId, fields }, securityLevel)),
  );

  server.registerTool(
    'zendesk_create_category',
    {
      description: 'Create a Help Center category (Guide manager/admin only). Requires a name; locale defaults to en-us. Confirm the change in-conversation before calling.',
      inputSchema: { name: z.string().min(1), locale: localeSchema.optional(), description: z.string().optional(), position: z.number().int().nonnegative().optional() },
    },
    async (fields) => okWithHandle(await createCategory(httpClient, cache, { fields }, securityLevel)),
  );
}
