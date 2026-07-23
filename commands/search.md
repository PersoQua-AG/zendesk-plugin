---
description: Search across Zendesk (tickets, users, organizations, groups).
argument-hint: "<search query>"
---

Search Zendesk for: **$ARGUMENTS**.

If the query is empty, ask what to search for and stop.

Run `zendesk_search` with `query:"$ARGUMENTS"`. If the user's phrasing implies a single entity type, pass `type` (`ticket` | `user` | `organization` | `group`) to narrow it. If the result set is large or the user wants an exhaustive export, use `zendesk_search_export` with an explicit `type`. To get just a count, use `zendesk_search_count`.

Summarize matches grouped by type in a compact table (id, key fields, a one-line descriptor); do not dump raw JSON. Offer `/zendesk:ticket <id>` for any ticket match. Read-only.
