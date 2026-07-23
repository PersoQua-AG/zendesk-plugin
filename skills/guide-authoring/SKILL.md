---
name: guide-authoring
description: Author and maintain Zendesk Help Center (Guide) content — create or update knowledge-base articles and their translations, and organize categories and sections. Use when the user wants to write, edit, publish, or translate a Help Center / KB article. Defaults to English (en-us) plus German (de) translations, converts Markdown to HTML, and confirms before every write.
---

# Zendesk Guide Authoring

Create and maintain Help Center content. All write tools require Guide manager/admin role and are confirmed in-conversation before firing.

## Orient first

- Browse structure: `zendesk_list_categories`, then `zendesk_list_sections` (articles live in sections, sections live in categories).
- Find existing content: `zendesk_search_articles` (`query`, optional `locale`) or `zendesk_list_articles`; read one with `zendesk_get_article` (`articleId`).
- You need a `sectionId` to create an article and a `categoryId` to create a section. Resolve these from the list tools before writing — never invent an id.

## Default locale policy: EN + DE

Unless the user says otherwise, author in **en-us** and provide a **de** translation:
1. Create the base article in `en-us`: `zendesk_create_article` (`sectionId`, `title`, `body`, `locale:"en-us"`, optional `draft:true`).
2. Add the German translation: `zendesk_create_article_translation` (`articleId`, `locale:"de"`, `title`, `body`).
Ask the user for the German text; if they only supply English, offer to translate and show them the German draft for approval before creating the translation — do not publish an unreviewed machine translation silently.

## Writing bodies

- Bodies convert **Markdown → HTML** by default. For rich content that Markdown can't express cleanly (tables, images, nested lists), pass `markdown:false` and provide raw HTML.
- Create articles as `draft:true` first when the user wants to review before publishing; flip to published with `zendesk_update_article` (`draft:false`) once approved.
- Update existing content: `zendesk_update_article` (`articleId`, any of `title`/`body`/`draft`); update a translation with `zendesk_update_article_translation` (`articleId`, `locale`, fields).

## Organizing

- New section: `zendesk_create_section` (`categoryId`, `name`, optional `description`/`position`).
- New category: `zendesk_create_category` (`name`, optional `description`/`position`).

## Confirm before writing

For each create/update, show the target (section/category/article id + locale) and a preview of title + body, and wait for confirmation. Report the resulting article/translation id and its Help Center URL after each successful write.
