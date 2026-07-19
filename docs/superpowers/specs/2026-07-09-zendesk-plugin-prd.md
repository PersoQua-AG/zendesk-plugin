# PRD — Zendesk Full-Spectrum Plugin for Claude Code

- **Date:** 2026-07-09
- **Owner:** r.pfisterer@persoqua.de
- **Status:** Draft — awaiting sign-off (Phase 2 check-in)
- **Deliverable:** Installable Claude Code plugin (TypeScript) bundling an MCP server + skills + slash commands + subagents.

---

## 1. Summary

Build a Claude Code plugin that lets a user manage **all** their Zendesk data, tickets, and operations from inside Claude — reading, creating, and updating across Support (tickets), Users & Organizations, Business Rules (views/macros/triggers/automations/SLAs), Help Center/Guide, plus a data-analytics layer over ticket metrics and incremental exports.

No official Zendesk MCP server exists. Existing community servers each cover only a slice (tickets-only, or Guide-only, or broad-but-shallow). This plugin fills the gap: broad **and** deep, with correct handling of the async/pagination/rate-limit traps that break most Zendesk integrations.

## 2. Goals & Non-Goals

**Goals**
- G1 — Full read/write coverage of the four selected API areas (Support, Users/Orgs, Business Rules, Guide) via MCP tools.
- G2 — Data-analytics tools: ticket metrics, SLA breaches, volume/trend reporting, incremental-export–backed bulk pulls.
- G3 — OAuth 2.0 authentication (authorization-code + PKCE), tokens stored securely; no plaintext secrets on disk.
- G4 — Correct-by-construction API handling: cursor pagination everywhere, a single account-wide rate limiter honoring `Retry-After`, automatic async-job polling.
- G5 — A Claude-native UX layer: skills + slash commands + a support subagent so common workflows are one command, not raw tool juggling. Includes a dedicated **DataAnalyst** skill and **TicketManager** skill.
- G6 — **Microsoft 365 bridge:** compose Zendesk with Outlook (mail), Teams (chat), Calendar, and SharePoint via the available Microsoft 365 MCP — escalate/notify/schedule/attach across the two systems. (Replaces any Slack path.)
- G7 — **Untrusted-content safety:** ticket/comment/attachment text is attacker-controllable → a prompt-injection screening pipeline wraps all inbound Zendesk content before it reaches the model.

**Non-Goals (this version)**
- N1 — **No destructive operations.** No delete / destroy_many / permanent-delete / merge / redact / mark-as-spam. (Read + create + update only.)
- N2 — No Talk (voice), Chat, or Sunshine Conversations (messaging). Separate hosts/auth models — deferred to a later phase. (Cross-channel handled instead via the M365 bridge, G6.)
- N3 — No Zendesk Explore programmatic access (no viable public API). Analytics is built on metrics + incremental export instead.
- N4 — No Sell (CRM) coverage.

## 3. Users & Use Cases

Primary user: an agent/admin operator working support from Claude Code.

- "Show me open high-priority tickets breaching SLA." → search/export + metrics.
- "Reply to ticket 4821 with a public comment and set it pending." → update ticket (comment + status).
- "Create a ticket on behalf of customer X." → create ticket with requester.
- "Bulk re-tag these 60 tickets and reassign to group Y." → update_many (async job, auto-polled).
- "Draft a response for this ticket" → support subagent.
- "Weekly volume + first-reply-time report for the last 30 days." → analytics skill over incremental export + metrics.
- "Publish a Help Center article in EN + DE." → Guide create article + translation.

## 4. Scope Decisions (confirmed 2026-07-09)

| Decision | Choice |
|---|---|
| Operation scope | Full **read/write, no delete/destructive** |
| API areas | Support/Tickets · Users & Orgs · Business Rules · Help Center/Guide · **Data Analytics** (metrics + incremental export) |
| Auth | **OAuth 2.0** (authorization-code + PKCE) |
| Deliverable | Full Claude Code **plugin**, **TypeScript** |
| Zendesk plan | **Professional** — 400 req/min; SLAs available; **ticket forms & custom roles are Enterprise-gated → read-only / degrade gracefully** |
| Testing | **Mocks/fixtures first**; live Zendesk integration deferred |
| Distribution | **Public release** → extra hardening + docs + marketplace.json + OSS license |

## 5. Architecture

```
zendesk-plugin/
├── .claude-plugin/plugin.json      # manifest: userConfig, mcpServers, skills, agents
├── src/
│   ├── server.ts                   # MCP server entry (stdio)
│   ├── auth/                       # OAuth PKCE flow + token store + refresh
│   ├── client/                     # HTTP client: rate limiter, CBP paginator, job poller, response cache
│   ├── security/                   # prompt-injection screening + content wrapping (G7)
│   ├── tools/                      # one module per area (tickets, users, orgs, rules, guide, analytics)
│   └── guards/                     # write/confirm guards, scope checks, optimistic concurrency
├── skills/                         # SKILL.md per workflow (incl. data-analyst, ticket-manager, o365-bridge)
├── commands/                       # slash commands
├── agents/support-agent.md         # drafting/triage subagent
└── README.md
```

**Stack:** TypeScript/Node ≥20, MCP SDK (`@modelcontextprotocol/sdk`), `node-zendesk` as the base client for common CRUD **with a raw-REST escape hatch** for the endpoints where library coverage lags (cursor pagination, `/search/export`, incremental export cursor mode, webhooks, side conversations, async job polling).

**Cross-cutting infrastructure (built once, used by every tool):**
1. **Single global rate limiter** — account-wide (limits are per-account, not per-connection). Honors `Retry-After` on 429 + exponential backoff; reads `X-Rate-Limit-Remaining`. Special-cases incremental export (10 req/min global).
2. **CBP paginator** — always sends `page[size]`, loops on `meta.has_more` / `links.next`. Never constructs offset URLs (OBP >10k = HTTP 400).
3. **Async job poller** — every bulk tool (`create_many`/`update_many`) polls `GET /job_statuses/{id}` to completion and surfaces per-record errors.
4. **Auth manager** — OAuth PKCE, token refresh, secure storage via plugin `userConfig` (`sensitive: true` → keychain, never settings.json).
5. **Response cache (save-first / query-later)** — *adopted from andmarios/zendesk-skill.* Every read tool writes its full JSON response to `${CLAUDE_PLUGIN_DATA}/cache/` and returns a summary + cache handle. A `zendesk_query` tool re-extracts fields (JSONPath/jq-style, with named presets like `comments_slim`) from a cached response — no re-fetch, big token savings during iterative analysis.
6. **Markdown↔HTML** — comment/article write tools convert Markdown→HTML for Agent Workspace / Guide rendering (`plain_text: true` opt-out); inbound HTML rendered to readable Markdown. *Adopted from andmarios.*

### 5.3 Security — untrusted-content pipeline (G7)

Ticket subjects, comments, user fields, and attachments are **attacker-controllable**. All inbound Zendesk content passes through a screening layer before reaching the model (*pattern adopted from andmarios/zendesk-skill*):
1. Regex + heuristic detection of known prompt-injection patterns.
2. Optional Haiku-based classifier for ambiguous content (config toggle; off by default for cost).
3. **Session-scoped delimiters** wrap all external content so the model treats it as data, not instructions.
4. Attachment handling: size-gated (skip/flag >1 MB), type allowlist, never auto-execute.
5. Trusted-ticket allowlist to bypass screening for known-safe sources.
Enabled by default; `security_level` config = `strict` | `standard` | `off`.

### 5.4 Microsoft 365 bridge (G6)

Composes this plugin's Zendesk tools with the **available Microsoft 365 MCP** (Outlook mail search/send, Teams chat, Calendar availability/events, SharePoint search). No new Zendesk endpoints — orchestration lives in the `o365-bridge` skill. Workflows:
- **Escalate to Teams:** post a ticket summary + link to a Teams channel/chat.
- **Email via Outlook:** send a ticket summary or customer-facing draft through Outlook (audit trail in mailbox).
- **Schedule follow-up:** create an Outlook Calendar event / find availability for a callback tied to a ticket.
- **Attach knowledge:** pull a SharePoint doc and reference/attach it in a ticket comment.

Dependency: the Microsoft 365 MCP must be **authorized** (OAuth via connector settings). It is currently unauthenticated in this environment — the bridge degrades gracefully (skill detects the MCP and instructs the user to connect it if absent). Requires no changes to the Zendesk MCP server itself.

### 5.1 Authentication (OAuth 2.0)

- Setup (documented, one-time): user registers an OAuth client in Zendesk Admin Center, sets an exact redirect URI (local callback, e.g. `http://localhost:{port}/callback`).
- Flow: authorization-code + PKCE → access token (`Bearer`) + refresh token. Auto-refresh on expiry.
- `userConfig` collects: `zendesk_subdomain`, `oauth_client_id`, and (sensitive) `oauth_client_secret`; the callback port is configurable.
- Effective permission = **token scopes ∩ authorizing user's role**. Requested scopes: `read write tickets:* users:* organizations:* hc:* triggers:read automations:read`.
- **Fallback (optional flag):** API-token auth (`email/token`) as a simpler path — not default, documented for internal single-user setups.

### 5.2 Guards (safety)

- Write tools require the user's confirmation-in-conversation for state changes (Claude proposes → user confirms). No auto-fire on ambiguous requests.
- Destructive endpoints are **not implemented** at all (enforced by omission, per N1) — not merely hidden.
- `PUT` tag semantics use the **append** path (`POST /tags`) by default to avoid the "PUT replaces all tags" data-loss trap; a `replace: true` opt-in exists.
- Macro `apply` clearly labeled as "preview only" — the tool returns the would-be result and, on confirmation, persists via a follow-up `PUT`.
- **Optimistic concurrency (`safe_update`)** — *adopted from davepoon/zendesk-automation.* Ticket updates pass the last-known `updated_stamp`; Zendesk returns **409 on conflict** (someone edited the ticket meanwhile). The tool re-fetches, shows the diff, and asks before overwriting — prevents silent clobbering of concurrent agent edits.
- **Lifecycle-state awareness** — TicketManager knows the `new → open → pending → hold → solved → closed` state machine; warns on invalid transitions (e.g. reopening a `closed` ticket is impossible → must create a follow-up).

## 6. MCP Tool Inventory

Namespaced `zendesk_*`. R = read, W = write. No destructive tools.

### Support / Tickets
| Tool | R/W | Endpoint |
|---|---|---|
| `zendesk_list_tickets` | R | `GET /tickets` (CBP) |
| `zendesk_get_ticket` / `zendesk_get_tickets_many` | R | `GET /tickets/{id}`, `/show_many` |
| `zendesk_create_ticket` | W | `POST /tickets` |
| `zendesk_update_ticket` | W | `PUT /tickets/{id}` (status, priority, assignee, fields; `updated_stamp` safe_update) |
| `zendesk_add_comment` | W | `PUT /tickets/{id}` w/ `comment` (public/private; Markdown→HTML) |
| `zendesk_create_tickets_bulk` | W | `POST /tickets/create_many` (job-polled) |
| `zendesk_update_tickets_bulk` | W | `PUT /tickets/update_many` (job-polled) |
| `zendesk_list_comments` | R | `GET /tickets/{id}/comments` |
| `zendesk_get_ticket_audits` | R | `GET /tickets/{id}/audits` (CBP) |
| `zendesk_add_ticket_tags` | W | `POST /tickets/{id}/tags` (append) |
| `zendesk_list_ticket_fields` / `_forms` | R | `GET /ticket_fields`, `/ticket_forms` |
| `zendesk_upload_attachment` | W | `POST /uploads` (for comment attachments) |

### Users & Organizations
| Tool | R/W | Endpoint |
|---|---|---|
| `zendesk_search_users` | R | `GET /users/search` |
| `zendesk_get_user` / `zendesk_get_me` | R | `GET /users/{id}`, `/users/me` |
| `zendesk_upsert_user` | W | `POST /users/create_or_update` (idempotent, external_id) |
| `zendesk_update_user` | W | `PUT /users/{id}` |
| `zendesk_list_user_identities` | R | `GET /users/{id}/identities` |
| `zendesk_list_orgs` / `zendesk_get_org` | R | `GET /organizations`, `/{id}` |
| `zendesk_upsert_org` | W | `POST /organizations/create_or_update` |
| `zendesk_update_org` | W | `PUT /organizations/{id}` |
| `zendesk_list_groups` / `zendesk_list_group_memberships` | R | `GET /groups`, `/group_memberships` |
| `zendesk_list_org_memberships` | R | `GET /organization_memberships` |

### Search
| Tool | R/W | Endpoint |
|---|---|---|
| `zendesk_search` | R | `GET /search` (≤1000 results; `type:` in query) |
| `zendesk_search_export` | R | `GET /search/export` (CBP, `filter[type]`, large sets) |
| `zendesk_search_count` | R | `GET /search/count` |

### Business Rules
| Tool | R/W | Endpoint |
|---|---|---|
| `zendesk_list_views` / `zendesk_get_view` | R | `GET /views`, `/views/{id}` |
| `zendesk_execute_view` | R | `GET /views/{id}/execute` / `/tickets` |
| `zendesk_view_count` | R | `GET /views/{id}/count` |
| `zendesk_list_macros` | R | `GET /macros` |
| `zendesk_preview_macro` | R | `GET /macros/{id}/apply` (preview only) |
| `zendesk_apply_macro_to_ticket` | W | preview → confirm → `PUT /tickets/{id}` |
| `zendesk_list_triggers` / `_automations` / `_slas` | R | `GET /triggers`, `/automations`, `/slas/policies` |
| `zendesk_create_trigger` / `zendesk_update_trigger` | W | `POST`/`PUT /triggers` (admin) |
| `zendesk_create_automation` / `zendesk_update_automation` | W | `POST`/`PUT /automations` (admin) |
| `zendesk_create_sla` / `zendesk_update_sla` | W | `POST`/`PUT /slas/policies` (admin) |

> Business-rules **writes** require admin role; tools surface a clear permission error when scope∩role is insufficient. (No delete of rules — per N1.)

### Help Center / Guide
| Tool | R/W | Endpoint |
|---|---|---|
| `zendesk_list_articles` / `zendesk_get_article` | R | `GET /help_center/articles` |
| `zendesk_search_articles` | R | `GET /help_center/articles/search` |
| `zendesk_create_article` / `zendesk_update_article` | W | `POST`/`PUT .../sections/{id}/articles` |
| `zendesk_create_article_translation` / `_update` | W | `POST`/`PUT .../articles/{id}/translations` |
| `zendesk_list_sections` / `_categories` | R | `GET .../sections`, `/categories` |
| `zendesk_create_section` / `zendesk_create_category` | W | `POST .../sections`, `/categories` |

### Data Analytics
| Tool | R/W | Endpoint / basis |
|---|---|---|
| `zendesk_ticket_metrics` | R | `GET /ticket_metrics`, `/tickets/{id}/metrics` |
| `zendesk_satisfaction_ratings` | R | `GET /satisfaction_ratings` (CSAT) |
| `zendesk_incremental_tickets` | R | `GET /incremental/tickets/cursor.json` (bulk sync, 10 req/min) |
| `zendesk_incremental_users` | R | `GET /incremental/users/cursor.json` |
| `zendesk_ticket_metric_events` | R | `GET /incremental/ticket_metric_events.json` |
| `zendesk_report` | R | composite: aggregates metrics/export into volume, SLA-breach, first-reply/resolution-time (calendar **and** business-hours), CSAT summaries |

### Utility
| Tool | R/W | Basis |
|---|---|---|
| `zendesk_query` | R | Re-extract fields from a cached response (JSONPath/jq + named presets); no re-fetch |
| `zendesk_get_me` | R | `GET /users/me` — auth + role preflight |

## 7. Claude-Native Layer

**Skills** (`skills/*/SKILL.md`)
- **`ticket-manager`** *(required)* — full ticket lifecycle: read context, update status/priority/assignee/tags, add public replies or internal notes (Markdown→HTML), bulk re-tag/reassign via `update_many` (job-polled). Uses `safe_update` optimistic concurrency + lifecycle-state validation. Append-by-default tags. Confirms before every write.
- **`data-analyst`** *(required)* — volume/trend/SLA-breach/first-reply/resolution-time (calendar **and** business-hours) + CSAT reporting over a date range. Built on incremental export + metrics + the response cache (`zendesk_query` for slicing without re-fetch). Configurable business hours/timezone/workdays.
- **`o365-bridge`** — Zendesk × Microsoft 365: escalate ticket to Teams, email summary/draft via Outlook, schedule follow-up in Calendar, attach SharePoint docs. Detects the M365 MCP; prompts to connect if absent.
- `triage-tickets` — pull open/pending, rank by SLA risk + priority, summarize.
- `guide-authoring` — create/update KB articles + translations (default locales EN + DE).

**Slash commands** (`commands/*.md`)
- `/zendesk:tickets` — quick open-ticket dashboard.
- `/zendesk:ticket <id>` — full ticket view (comments + metrics + audits).
- `/zendesk:report <range>` — analytics report (invokes `data-analyst`).
- `/zendesk:search <query>` — search across Zendesk.
- `/zendesk:escalate <id>` — push a ticket to Teams/Outlook via `o365-bridge`.

**Subagent** (`agents/support-agent.md`) — reads ticket context via MCP tools, drafts empathetic professional responses, does not write files; write actions gated on user confirmation.

## 8. Configuration (`userConfig`)

| Key | Type | Sensitive | Purpose |
|---|---|---|---|
| `zendesk_subdomain` | string | no | `{subdomain}.zendesk.com` |
| `oauth_client_id` | string | no | Registered OAuth client |
| `oauth_client_secret` | string | **yes** | OAuth client secret (keychain) |
| `oauth_callback_port` | number | no | Local redirect port (default 8976) |
| `default_group_id` | number | no | Optional default assignment group |
| `auth_mode` | enum(`oauth`\|`api_token`) | no | Default `oauth`; token = internal fallback |
| `security_level` | enum(`strict`\|`standard`\|`off`) | no | Injection-screening level (default `standard`) |
| `timezone` / `work_hours` / `workdays` | string/json | no | Business-hours basis for `data-analyst` FRT/SLA calc |
| `markdown_conversion` | boolean | no | Markdown→HTML on writes (default `true`) |

## 9. Milestones (Phase 3 build)

- **M0 — Skeleton:** plugin manifest, MCP server boot, `userConfig`, OAuth PKCE flow + token store, `zendesk_get_me` (auth smoke test).
- **M1 — Core infra:** rate limiter, CBP paginator, async job poller, response cache + `zendesk_query`, security screening pipeline (§5.3), Markdown↔HTML, raw-REST client + node-zendesk wiring, error mapping (429/scope/validation/409-conflict).
- **M2 — Support tools:** tickets CRUD (no delete), comments, tags, fields/forms read, bulk create/update, search + search/export.
- **M3 — Users/Orgs tools:** upsert users/orgs, search, identities, groups/memberships.
- **M4 — Business Rules:** views execute, macros preview/apply, triggers/automations/SLAs read + create/update.
- **M5 — Guide:** articles/sections/categories + translations.
- **M6 — Analytics:** metrics, satisfaction ratings, incremental export tools, composite `zendesk_report` (calendar + business-hours) → powers `data-analyst`.
- **M7 — Claude layer:** skills (`ticket-manager`, `data-analyst`, `o365-bridge`, `triage-tickets`, `guide-authoring`), slash commands, support subagent. M365 bridge wired to the Microsoft 365 MCP.
- **M8 — Packaging (public release):** README + setup/screenshots, OSS license, `claude plugin validate --strict`, `marketplace.json`, secret-safe logging, contract-test suite green.

Each milestone: TDD (tests before implementation), verified against Zendesk before moving on.

## 10. Testing Strategy

- Unit: rate limiter, paginator, job poller, OAuth token refresh, guard logic — mocked HTTP.
- Contract: recorded Zendesk API fixtures per endpoint (nock/msw) covering the 10 known traps (async job, PUT-tags, macro-apply, OBP-400, search-1000-cap, 429/Retry-After, scope∩role, eventual-consistency, subdomain host, CBP).
- Integration: live smoke tests against a Zendesk sandbox (auth, create ticket, comment, search, incremental export).
- `claude plugin validate --strict` in CI.

## 11. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| OAuth PKCE + local callback friction on a headless/CLI plugin | Documented setup; API-token fallback flag; clear error messages; callback port configurable. |
| Rate limits (esp. incremental export 10/min global) | Single global limiter + Retry-After; incremental export scheduled/serialized; caching of field/view/macro defs. |
| Async-job silent partial failure | Poller surfaces per-record errors; bulk tools return a result table, not a boolean. |
| Scope∩role permission surprises (admin-only rules) | Preflight `get_me` role check; map 403 to actionable message. |
| `node-zendesk` lagging newer endpoints | Raw-REST escape hatch for search/export, incremental, webhooks, side conversations. |
| Accidental data loss via tags/macros | Append-by-default tags; macro apply is preview→confirm→persist. |
| **Prompt injection via ticket content** | Screening pipeline + session-scoped delimiters (§5.3); content treated as data; attachment gating. |
| **Concurrent-edit clobbering** | `safe_update` optimistic concurrency (409 → re-fetch + confirm). |
| **M365 MCP not authorized** | `o365-bridge` degrades gracefully; detects + instructs user to connect; Zendesk core unaffected. |

## 12. Open Questions

**Resolved (2026-07-09 check-in):**
1. ~~Plan tier~~ → **Professional.** Consequences: rate limiter capped at 400 req/min; SLA read/write available; **ticket-form create/update dropped (Enterprise-only) → forms read-only**; no custom-role tooling; side conversations excluded.
2. ~~Test env~~ → **Mocks/fixtures first.** M8 live integration becomes optional/deferred; contract tests carry correctness.
4. ~~Distribution~~ → **Public.** Adds: OSS license, hardened error handling + input validation, README with setup + screenshots, `marketplace.json`, `claude plugin validate --strict` gate, no secrets in logs.

**Still open (non-blocking, defaults chosen):**
3. **Single-user or multi-account?** → assume **single-user OAuth PKCE** unless told otherwise.
5. **Analytics depth** → metrics + incremental-export reporting; external BI/warehouse export deferred.
6. **Guide locales** → default EN + DE; confirm at M5.

## 13. Prior Art & Patterns Adopted (reverse-engineered)

| Source | Patterns adopted into this design |
|---|---|
| [andmarios/zendesk-skill](https://github.com/andmarios/zendesk-skill) (Python, CLI+MCP) | **Save-first/query-later** response cache + named jq presets (§5 infra 5); **prompt-injection security pipeline** + session-scoped content wrapping + attachment gating (§5.3); **Markdown↔HTML** conversion (§5 infra 6); business-hours/FRT/on-call config for analytics; OAuth auto-refresh (ports 8080–8089). |
| [davepoon/buildwithclaude — zendesk-automation](https://github.com/davepoon/buildwithclaude/tree/main/plugins/all-skills/skills/zendesk-automation) (SKILL.md, Rube MCP) | **`safe_update` optimistic concurrency** (ISO-8601 `updated_stamp`, 409 on conflict) → §5.2; **lifecycle-state model** (new→open→pending→hold→solved→closed) → `ticket-manager`; prerequisite-query pattern (search user before assign); confirmed tag-replace trap. |
| [fruggr/zendesk-mcp-server](https://github.com/fruggr/zendesk-mcp-server) (TS, OAuth PKCE) | OAuth 2.1 **PKCE** model, namespaced tools, `npx`-runnable packaging — best-engineered TS reference. |
| [mattcoatsworth/zendesk-mcp-server](https://github.com/mattcoatsworth/zendesk-mcp-server) | Broadest tool-surface inventory (tickets/users/orgs/groups/macros/views/triggers/automations/search/guide) — coverage checklist. |

**Delta vs. all prior art:** none combine broad+deep coverage, business-rules writes, incremental-export analytics, injection security, optimistic concurrency, **and** an M365 bridge in a single TypeScript Claude plugin. That is this project's contribution.

---

*Sources: Zendesk Developer docs (developer.zendesk.com) — tickets, users, orgs, search, business rules, help center, pagination, rate limits, incremental export, webhooks, auth; Claude Code plugin reference (code.claude.com/docs). Full URLs captured in research notes.*
