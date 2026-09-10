# Zendesk Plugin for Claude Code

Manage your entire Zendesk operation from inside Claude Code — Support/Tickets,
Users & Organizations, Business Rules (views/macros/triggers/automations/SLAs),
Help Center/Guide, and a data-analytics layer over ticket metrics and
incremental exports. Includes a Microsoft 365 bridge (Outlook/Teams/Calendar/
SharePoint).

65 MCP tools (64 Zendesk tools + `zendesk_login`) · 5 skills · 5 slash commands ·
a support subagent. Ships two ways: a Claude Code plugin and a Claude Desktop
Extension (`.mcpb`).

> Scope: full **read/write, no destructive operations** (no delete/merge/redact).
> OAuth 2.0 (authorization-code + PKCE). TypeScript, Node ≥ 20.

## Screenshots

_(Placeholder — add before publishing: 1. the `/zendesk:tickets` dashboard,
2. a `/zendesk:report` analytics run, 3. the one-time authorize flow in a
terminal. Images cannot be generated in the build environment.)_

## Install

Two supported paths. **Claude Desktop** users install the packed extension;
**Claude Code** users install the plugin from the marketplace.

### A. Claude Desktop Extension (`.mcpb`)

No terminal required.

1. Register the OAuth client in Zendesk (see [Setup step 1](#1-register-an-oauth-client-in-zendesk)).
2. **Settings → Extensions → Advanced settings → Install extension…** and pick
   `zendesk.mcpb`.
3. Fill in the configuration dialog. Only three fields are required:

   | Field | Required | Default |
   |---|---|---|
   | Zendesk Subdomain | **yes** | — |
   | OAuth Client ID | **yes** | — |
   | OAuth Client Secret | **yes** (stored as a secret) | — |
   | OAuth Callback Port | no | `8976` |
   | Injection-Screening Level | no | `standard` |
   | Markdown to HTML Conversion | no | on |
   | Business-Hours Timezone | no | UTC |
   | Business Work Hours | no | 09:00–17:00 |
   | Business Workdays | no | Mon–Fri |

   The **redirect URI you register in Zendesk must match the callback port**:
   `http://localhost:<OAuth Callback Port>/callback` — with the default port,
   `http://localhost:8976/callback`.
4. In a chat, run the **`zendesk_login`** tool. It returns a Zendesk
   authorization URL — open it, approve, and the extension captures the
   redirect and stores the credentials encrypted. It reports
   *already authorized* if usable credentials exist; pass `force: true` to
   authorize again.
5. Verify with **`zendesk_get_me`** ("Who am I in Zendesk?").

If the extension is installed but not yet configured, it still starts and every
tool answers with the configuration field that is still empty, rather than
failing silently.

Build the bundle yourself:

```bash
npm ci && npm run build             # dist/ is what the bundle runs
npm ci --omit=dev --ignore-scripts  # bundle only the four runtime dependencies
npm run pack                        # → zendesk.mcpb (via npx @anthropic-ai/mcpb)
npm ci                              # restore the dev toolchain
```

The two `npm ci` runs around `pack` are what keeps the bundle small: `mcpb pack`
ships whatever is in `node_modules`, and the test/build toolchain has no business
inside a shipped extension. `npm run pack` refuses to run until the tree is a
production tree, so forgetting the step fails loudly instead of shipping 17 MB.
`.mcpbignore` drops the sources, tests, the Claude Code plugin layer and the
local data directory (`tokens.enc` must never enter a bundle); the four runtime
dependencies stay in on purpose, so the extension is self-contained. Packaging
adds **no** dependency of its own — the MCPB CLI is fetched through `npx`.

> **Why `zendesk_login` exists.** The stdio tool surface gains exactly one tool,
> because a Desktop Extension user has no terminal to run `npm run authorize` in;
> it is offered only on the local path, never on the remote connector.

### B. Claude Code plugin

From Claude Code, add the marketplace and install the plugin:

```
/plugin marketplace add PersoQua-AG/zendesk-plugin
/plugin install zendesk@zendesk
```

`marketplace add` / `plugin install` clone only committed files and do **not**
run a build, so the compiled `dist/` is committed to the repo (see note below).

To work on the plugin from source instead:

```bash
git clone https://github.com/PersoQua-AG/zendesk-plugin.git
cd zendesk-plugin
npm install   # `prepare` runs the build automatically
```

> **`dist/` is committed on purpose** so the marketplace install runs without a
> build step. Whenever you change anything under `src/`, re-run `npm run build`
> and commit the updated `dist/` — a stale or missing `dist/` means
> `MODULE_NOT_FOUND` on a real install.

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
**Desktop Extension:** run the `zendesk_login` tool in a chat — that is the
whole step.

**Claude Code:** the one-time first-token flow runs a local browser callback via
the CLI. From the plugin directory, with the same
subdomain / client credentials **and the same `CLAUDE_PLUGIN_DATA`** the server
uses exported:

```bash
export ZENDESK_SUBDOMAIN=acme
export ZENDESK_OAUTH_CLIENT_ID=...        # from step 1
export ZENDESK_OAUTH_CLIENT_SECRET=...    # from step 1
export CLAUDE_PLUGIN_DATA=...             # MUST match what the server uses (see below)
export ZENDESK_OAUTH_CALLBACK_PORT=8976   # only if you overrode oauth_callback_port
npm run authorize
```

It prints an authorization URL — open it in your browser, approve, and the CLI
captures the redirect, exchanges the code, and saves encrypted tokens
(AES-256-GCM) to the resolved `tokens.enc` path, which it prints. The plugin
then refreshes the token automatically; you only re-run `authorize` if you
revoke access or rotate the client secret.

> **`CLAUDE_PLUGIN_DATA` must match.** The server receives `CLAUDE_PLUGIN_DATA`
> from its `plugin.json` env and reads `tokens.enc` from `$CLAUDE_PLUGIN_DATA`.
> The `authorize` CLI writes to the **same** path only if you export the same
> value — otherwise it writes to the default per-user data directory and the
> server reports "No authorization found". If you leave `CLAUDE_PLUGIN_DATA`
> unset, the CLI prints a warning and the absolute path it used; make sure that
> path is where the server looks. The tokens are encrypted with a key derived
> from your client secret, so the same credentials + same path let the server
> pick them up with no extra steps.

> **Where credentials live.** With `CLAUDE_PLUGIN_DATA` unset — which is the
> Desktop Extension case — `tokens.enc` (mode `0600`) and the response cache go
> to a stable per-user directory: `~/Library/Application Support/zendesk-plugin`
> on macOS, `%APPDATA%\zendesk-plugin` on Windows,
> `$XDG_DATA_HOME/zendesk-plugin` (or `~/.local/share/zendesk-plugin`) elsewhere.
> It sits outside the extension directory, so an extension update does not
> discard the authorization. The bundle itself never contains credentials.

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
`zendesk_login` (authorize this installation) plus 64 namespaced `zendesk_*`
tools across Support, Users/Orgs, Search, Business
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
npm run pack      # → zendesk.mcpb (Desktop Extension bundle)
node scripts/validate-manifests.mjs   # manifest.json + plugin.json + marketplace.json
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin validate --strict .claude-plugin/marketplace.json
```

## Documents

- [PRD](docs/superpowers/specs/2026-07-09-zendesk-plugin-prd.md)
- [Foundation plan (M0+M1)](docs/superpowers/plans/2026-07-09-zendesk-plugin-foundation.md)
- [Packaging plan (M8)](docs/superpowers/plans/2026-07-23-packaging.md)

## License

[MIT](LICENSE) © Persoqua
