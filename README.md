# Zendesk Plugin for Claude Code

Manage your entire Zendesk operation from inside Claude Code — Support/Tickets,
Users & Organizations, Business Rules (views/macros/triggers/automations/SLAs),
Help Center/Guide, and a data-analytics layer over ticket metrics and
incremental exports. Includes a Microsoft 365 bridge (Outlook/Teams/Calendar/
SharePoint).

66 MCP tools (64 Zendesk tools + `zendesk_login` + `zendesk_diagnostics`) ·
first-run setup on a local page ·
5 skills · 5 slash commands ·
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
   | OAuth Client Secret | **yes** | — |
   | OAuth Callback Port | no | `8976` |
   | Injection-Screening Level | no | `standard` — fixed, see [Security](#security) |
   | Markdown to HTML Conversion | no | on |
   | Business-Hours Timezone | no | UTC |
   | Business Work Hours | no | 09:00–17:00 |
   | Business Workdays | no | Mon–Fri |

   Each organization registers its **own confidential** OAuth client in its own
   Zendesk; the plugin ships no subdomain, no client id and no secret, and a
   public (secret-less) client is deliberately not the shipped path — it belongs
   to exactly one instance. PKCE (S256) is on unconditionally either way.

   The **redirect URI you register in Zendesk must match the callback port**:
   `http://localhost:<OAuth Callback Port>/callback` — with the default port,
   `http://localhost:8976/callback`.
4. In a chat, run the **`zendesk_login`** tool **twice** — or simply ask for
   something from Zendesk, because the first tool call without valid credentials
   starts the authorization itself and answers with the URL:
   - The **first call** returns a Zendesk authorization URL and starts listening
     for the redirect. Open the URL, approve access — the browser tab confirms
     the redirect landed. This call does not wait for you; the authorization
     stays open for 5 minutes.
   - The **second call** finishes the login: it exchanges the code and stores
     the credentials encrypted. Called too early, it repeats the URL and says it
     is still waiting; called after the 5 minutes, it says so and the next call
     starts a fresh authorization.

   It reports *already authorized* if usable credentials exist; pass
   `force: true` to authorize again, or to restart an authorization in progress.
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

> **Why `zendesk_login` exists, and why it takes two calls.** The stdio tool
> surface gains exactly one tool, because a Desktop Extension user has no
> terminal to run `npm run authorize` in. It needs two calls because a tool
> result reaches the user only when the call returns: a single call that waited
> for the browser redirect would reveal the URL to open only once it was already
> too late to open it. The first call therefore publishes the URL and keeps the
> localhost listener bound in the background; the second collects the result.
> The tool is offered only on the local path, never on the remote connector —
> the flow is per process, and the listener is on localhost.

### B. Claude Code plugin

From Claude Code, add the marketplace and install the plugin:

```
/plugin marketplace add PersoQua-AG/zendesk-plugin
/plugin install zendesk@zendesk
```

`marketplace add` / `plugin install` clone only committed files and do **not**
run a build, so the compiled `dist/` is committed to the repo (see note below).

The plugin asks for **no configuration of its own**: the Claude Code host bridge
does not support plugin user configuration and drops the whole MCP server when a
manifest references any (`user_config is not supported on the desktop host
bridge; dropping server`). Settings therefore reach the server as ordinary
environment variables — and when there are none, the **first-run setup page**
takes over (see below), so nothing has to be configured by hand at all. `zendesk_diagnostics` reports what the
host actually did with the plugin — platform, whether `${CLAUDE_PLUGIN_ROOT}` and
`${CLAUDE_PLUGIN_DATA}` were substituted by the host (it reads neither for its data
directory), the client capabilities announced in
`initialize`, and whether the callback port binds on each address family. It
reports those as states, never as values, so its output is safe to paste into an
issue.

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

### 0. First run: let the plugin walk you through it

Ask Claude for anything from Zendesk on a machine that is not configured yet. The
answer is a single local URL — `http://127.0.0.1:8976/setup?t=…`, or
`http://[::1]:8976/…` when that is the loopback family the listener got — and
nothing else. Open it and the page (in German) does both halves of the job:

1. it names the exact place in **your** Zendesk — Admin Center → Apps und
   Integrationen → APIs → OAuth-Clients → „OAuth-Client hinzufügen" — and the
   exact values to enter there: the redirect URL
   `http://localhost:8976/callback`, client type *vertraulich* (confidential),
   and *Zugriffsart* left empty (empty means all scopes are allowed; the plugin
   asks for `read write`);
2. it collects subdomain, client id and client secret, stores all three in the
   **macOS Keychain** (all three or none — a write that fails takes back what it
   already stored), and continues straight into the Zendesk authorization in the
   same browser tab. The callback lands on the same local listener, the tokens
   are encrypted to disk, and **the running session picks the configuration up
   itself** — nothing has to be reloaded or restarted.

Why a page and not a question in the chat: the client secret must never pass
through the model or end up in a transcript. The MCP specification says so
outright — *"Servers MUST NOT use form mode elicitation to request sensitive
information such as passwords, API keys, access tokens, or payment
credentials."* The page runs on loopback only, is reachable solely with a
single-use token, accepts the form by `POST` from its own origin, and echoes no
value back. The listener exists only while a setup or a login is pending.

`zendesk_login` with **`setup: true`** reaches the page again when the stored
values are the wrong ones — a subdomain typed `acmee`, a client deleted in
Zendesk, a different account. (`force: true` keeps its own meaning: authorize
again with the configuration that is there.) Values typed into the page never
travel as process arguments: they are handed to `security` on stdin, so they are
not visible to `ps`.

Environment variables always win over the Keychain, so **Claude Code with
`ZENDESK_SUBDOMAIN` etc. set behaves exactly as it did before** and never touches
the Keychain for its configuration at all. On Windows and Linux there is no key
source yet ([#69](https://github.com/PersoQua-AG/zendesk-plugin/issues/69)): the
setup page is not offered there, and the plugin says what is missing instead.

### 1. Register an OAuth client in Zendesk
In **Zendesk Admin Center → Apps and integrations → APIs → Zendesk API →
OAuth Clients**, create a client and set the redirect URI **exactly** to:

```
http://localhost:8976/callback
```

(Use your chosen port if you override `oauth_callback_port`.) Note the
**Client ID** and **Client Secret**.

### 2. Provide plugin configuration
The Desktop Extension (`.mcpb`) asks for these in its configuration dialog. On the
Claude Code plugin they are environment variables (`ZENDESK_SUBDOMAIN`,
`ZENDESK_OAUTH_CLIENT_ID`, …) — see section B.

| Key | Type | Required | Purpose |
|---|---|---|---|
| `zendesk_subdomain` | string | yes | `{subdomain}.zendesk.com` |
| `oauth_client_id` | string | yes | From step 1 |
| `oauth_client_secret` | string (sensitive) | yes | From step 1 — stored in the macOS Keychain when the setup page collects it, never on disk in the clear |
| `oauth_callback_port` | number | no | Localhost redirect port (default `8976`) |
| `security_level` | `strict`\|`standard`\|`off` | no | Prompt-injection screening. Fixed at `standard` in the installed plugin — only a hand-started server reads `ZENDESK_SECURITY_LEVEL`, see [Security](#security) |
| `markdown_conversion` | boolean | no | Markdown→HTML on writes (default `true`) |
| `timezone` | string | no | IANA tz for business-hours metrics (e.g. `Europe/Berlin`) |
| `work_hours` | JSON | no | `{"start":"09:00","end":"17:00"}` |
| `workdays` | JSON | no | ISO weekdays, e.g. `[1,2,3,4,5]` |

### 3. Authorize (one time)
**Desktop Extension:** run the `zendesk_login` tool in a chat, open the URL it
returns, then run `zendesk_login` once more to finish — that is the whole step
(see section A, step 4).

**Claude Code:** the one-time first-token flow runs a local browser callback via
the CLI. From the plugin directory, with the same subdomain and client
credentials the server uses exported:

```bash
export ZENDESK_SUBDOMAIN=acme
export ZENDESK_OAUTH_CLIENT_ID=...        # from step 1
export ZENDESK_OAUTH_CLIENT_SECRET=...    # only for a confidential client
export ZENDESK_OAUTH_CALLBACK_PORT=8976   # only if you overrode oauth_callback_port
npm run authorize
```

It prints an authorization URL — open it in your browser, approve, and the CLI
captures the redirect, exchanges the code, and saves encrypted tokens
(AES-256-GCM) to the resolved `tokens.enc` path, which it prints. The plugin
then refreshes the token automatically; you only re-run `authorize` if you
revoke access or rotate the client secret.

> **There is no path to match.** The `authorize` CLI and the server resolve the
> same directory on their own, so nothing has to be exported to line them up —
> the CLI prints the absolute `tokens.enc` path it used, and that is where the
> server looks. The tokens are encrypted with a random key kept in the macOS
> Keychain (service `zendesk-plugin`, account `token-store-key`), created on
> first use, so the **path** is all the server needs to pick them up and
> rotating the client secret leaves the store readable.

> **Where credentials live.** `tokens.enc` (mode `0600`) and the response cache
> go to one stable per-user directory, the same under Claude Code and the Desktop
> Extension: `~/Library/Application Support/zendesk-plugin` on macOS,
> `%APPDATA%\zendesk-plugin` on Windows, `$XDG_DATA_HOME/zendesk-plugin` (or
> `~/.local/share/zendesk-plugin`) elsewhere. It sits outside the plugin and
> extension directories, so an update does not discard the authorization, and it
> does not move when a host changes how it launches the server (#68). The bundle
> itself never contains credentials.

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
`zendesk_login` (authorize this installation), `zendesk_diagnostics` (what this
host did with the plugin — platform, variable substitution, client capabilities,
callback bind per address family; states only, never values) plus 64 namespaced `zendesk_*`
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
  The level is **not selectable in the installed plugin**: it is fixed at
  `standard`. `ZENDESK_SECURITY_LEVEL` (`strict` | `standard` | `off`) is read
  only when the server is started by hand from a shell, or by a remote-connector
  deployment (deprioritised since 2026-09-23). `.claude-plugin/plugin.json`
  declares no configuration of its own since
  [#68](https://github.com/PersoQua-AG/zendesk-plugin/issues/68), and the `.mcpb`
  dialog is the retired path. At `security_level=off` the fence is dropped but
  forged delimiters are still stripped, patterns are still detected, and every
  tool result says screening is off.
- **No destructive operations.** Delete/merge/redact/mark-as-spam are not
  implemented at all — enforced by omission.
- **Safe writes.** Ticket updates use optimistic concurrency (`safe_update`,
  409-on-conflict → re-fetch + confirm); tags append by default; macro apply is
  preview → confirm → persist; every write is confirmed in conversation.
- **Secrets.** The OAuth client secret reaches the server either as
  `ZENDESK_OAUTH_CLIENT_SECRET` (the MCPB manifest marks that field
  `sensitive: true`, which is a request to the host, not a guarantee from here)
  or from the **macOS Keychain**, where the first-run page puts it together with
  the subdomain and the client id — three items under the service
  `zendesk-plugin`, separate from the token-store key. It is never written to
  disk in the clear, never logged, and never echoed back by the page that
  collected it, and never passed as a command-line argument. Tokens are
  encrypted at rest
  (AES-256-GCM, file mode `0600`) with a **random 32-byte key of their own**, kept
  in the macOS Keychain and independent of the client secret: rotating the secret
  does not brick the token store, and the secret is not a decrypt-all key. On
  Windows and Linux the key source is not implemented yet
  ([#69](https://github.com/PersoQua-AG/zendesk-plugin/issues/69)) and the server
  says so rather than falling back to anything weaker. No secrets or tokens are
  ever written to logs or stdout.
- **The OAuth callback is loopback-only.** The listener binds `127.0.0.1` and
  `::1` — both, because `localhost` resolves to `::1` first on macOS — and
  nothing else, so it is not reachable from the network while it is open.

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
