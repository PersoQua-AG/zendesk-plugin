# Zendesk Plugin for Claude Code

Manage your entire Zendesk operation from inside Claude Code — Support/Tickets,
Users & Organizations, Business Rules (views/macros/triggers/automations/SLAs),
Help Center/Guide, and a data-analytics layer over ticket metrics and
incremental exports. Includes a Microsoft 365 bridge (Outlook/Teams/Calendar/
SharePoint).

64 MCP tools · 5 skills · 5 slash commands · a support subagent.

> Scope: full **read/write, no destructive operations** (no delete/merge/redact).
> OAuth 2.0 (authorization-code + PKCE). TypeScript, Node ≥ 20.

## Screenshots

_(Placeholder — add before publishing: 1. the `/zendesk:tickets` dashboard,
2. a `/zendesk:report` analytics run, 3. the one-time authorize flow in a
terminal. Images cannot be generated in the build environment.)_

## Install

Add the marketplace and install the plugin, then build it:

```bash
git clone https://github.com/PersoQua-AG/zendesk-plugin.git
cd zendesk-plugin
npm install
npm run build
```

## Setup

### 1. Register an OAuth client in Zendesk
In **Zendesk Admin Center → Apps and integrations → APIs → Zendesk API →
OAuth Clients**, create a client and set the redirect URI **exactly** to:

```
http://localhost:8976/callback
```

(Use your chosen port if you override `oauth_callback_port`.) Note the
**Client ID** and **Client Secret**.

### 2. Provide plugin configuration
When Claude Code installs the plugin it prompts for `userConfig`:

| Key | Type | Required | Purpose |
|---|---|---|---|
| `zendesk_subdomain` | string | yes | `{subdomain}.zendesk.com` |
| `oauth_client_id` | string | yes | From step 1 |
| `oauth_client_secret` | string (sensitive) | yes | From step 1 — stored in the OS keychain, never in settings |
| `oauth_callback_port` | number | no | Localhost redirect port (default `8976`) |
| `security_level` | `strict`\|`standard`\|`off` | no | Prompt-injection screening (default `standard`) |
| `markdown_conversion` | boolean | no | Markdown→HTML on writes (default `true`) |
| `timezone` | string | no | IANA tz for business-hours metrics (e.g. `Europe/Berlin`) |
| `work_hours` | JSON | no | `{"start":"09:00","end":"17:00"}` |
| `workdays` | JSON | no | ISO weekdays, e.g. `[1,2,3,4,5]` |

### 3. Authorize (one time)
The one-time first-token flow runs a local browser callback, so it is a CLI
step, not an in-chat action. From the plugin directory, with the same
subdomain / client credentials exported:

```bash
export ZENDESK_SUBDOMAIN=acme
export ZENDESK_OAUTH_CLIENT_ID=...        # from step 1
export ZENDESK_OAUTH_CLIENT_SECRET=...    # from step 1
npm run authorize
```

It prints an authorization URL — open it in your browser, approve, and the CLI
captures the redirect, exchanges the code, and saves encrypted tokens
(AES-256-GCM) under the plugin data directory. The plugin then refreshes the
token automatically; you only re-run `authorize` if you revoke access or rotate
the client secret.

> The tokens are encrypted with a key derived from your client secret and match
> the path the server reads, so the server picks them up with no extra steps.

### 4. Confirm
Ask Claude: **"Who am I in Zendesk?"** → runs `zendesk_get_me` and confirms auth.

## Usage

### Skills
- **`ticket-manager`** — full ticket lifecycle: read context, set
  status/priority/assignee/tags, add public replies or internal notes, bulk
  re-tag/reassign. Optimistic concurrency (`safe_update`), lifecycle-state
  validation, append-by-default tags, confirm before every write.
- **`data-analyst`** — volume / trend / SLA-breach / first-reply /
  resolution-time (calendar **and** business-hours) + CSAT over a date range.
- **`o365-bridge`** — Zendesk × Microsoft 365: escalate to Teams, email a
  summary/draft via Outlook, schedule a follow-up in Calendar, attach a
  SharePoint doc. Degrades gracefully if the M365 MCP is not connected.
- **`triage-tickets`** — pull open/pending, rank by SLA risk + priority.
- **`guide-authoring`** — create/update KB articles + translations (EN + DE).

### Slash commands
- `/zendesk:tickets` — open-ticket dashboard
- `/zendesk:ticket <id>` — full ticket view (comments + metrics + audits)
- `/zendesk:report <range>` — analytics report
- `/zendesk:search <query>` — search across Zendesk
- `/zendesk:escalate <id>` — push a ticket to Teams/Outlook

### Tools
64 namespaced `zendesk_*` tools across Support, Users/Orgs, Search, Business
Rules, Guide, Analytics, and a `zendesk_query` utility that re-slices cached
responses without re-fetching. Read tools save the full JSON response to the
plugin cache and return a summary + handle (token-efficient iteration). See the
[PRD](docs/superpowers/specs/2026-07-09-zendesk-plugin-prd.md) §6 for the full
inventory.

## Security

- **Prompt-injection screening.** Ticket/comment/user content is
  attacker-controllable; all inbound Zendesk content is screened and wrapped in
  session-scoped delimiters so the model treats it as data, not instructions.
  Level via `security_level` (`strict` | `standard` | `off`).
- **No destructive operations.** Delete/merge/redact/mark-as-spam are not
  implemented at all — enforced by omission.
- **Safe writes.** Ticket updates use optimistic concurrency (`safe_update`,
  409-on-conflict → re-fetch + confirm); tags append by default; macro apply is
  preview → confirm → persist; every write is confirmed in conversation.
- **Secrets.** The client secret is stored in the OS keychain; tokens are
  encrypted at rest (AES-256-GCM). No secrets or tokens are ever written to
  logs or stdout.

### Known limitation — rich Guide articles
The Markdown→HTML converter handles standard comment/article formatting. For
Help Center articles with complex layout (nested tables, embedded media, custom
classes), pass raw HTML directly rather than relying on Markdown conversion.

## Development

```bash
npm install
npm test          # vitest — full suite
npm run build     # tsc
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin validate --strict .claude-plugin/marketplace.json
```

## Documents

- [PRD](docs/superpowers/specs/2026-07-09-zendesk-plugin-prd.md)
- [Foundation plan (M0+M1)](docs/superpowers/plans/2026-07-09-zendesk-plugin-foundation.md)
- [Packaging plan (M8)](docs/superpowers/plans/2026-07-23-packaging.md)

## License

[MIT](LICENSE) © Persoqua
