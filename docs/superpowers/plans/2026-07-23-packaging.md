# Implementation Plan — M8 Packaging / Public Release

- **Date:** 2026-07-23
- **Milestone:** M8 (PRD §9) — Packaging (public release)
- **Branch:** `feature/zendesk-plugin-full-build`
- **Predecessors:** M0–M7 done + reviewed (389 tests green, 64 tools, 5 skills + 5 commands + support-agent, `claude plugin validate .` passes, CI exists).
- **Spirit:** Ponytail. Ship the *minimal* work that makes this a valid, installable, usable public release. Reuse existing modules. No new dependencies. No gold-plating.

## Goal

Close the one real completeness gap (OAuth **first-token** acquisition — the auth modules exist but nothing runs the authorization-code exchange, so the server can only refresh a token it never obtained) and add the packaging artifacts a public release needs: OSS license, `marketplace.json`, release README, secret-safe-logging guarantee, and a `validate --strict` + full-suite release gate.

## Design — OAuth first-token setup entry

### Why a `bin` script, not an MCP tool
The first-token flow needs a **localhost browser callback** (`waitForAuthorizationCode` binds an HTTP server on the callback port and waits for the redirect). That does not fit an MCP stdio tool: the server's stdout is the MCP transport, and the flow is a one-time, human-in-the-loop, browser-driven step run *before* the server is useful. So it is a standalone CLI entry (`bin`), runnable via an npm script / `node dist/bin/authorize.js`, exactly the `npx`-runnable packaging the PRD's best-engineered prior art (fruggr) uses.

### Pure wiring — zero new crypto/flow logic
The entry composes existing functions only:
1. `generateCodeVerifier()` / `generateCodeChallenge()` — `src/auth/pkce.ts`.
2. `buildAuthorizationUrl(config, challenge, state)` — `src/auth/oauth-flow.ts`; printed for the user to open.
3. `waitForAuthorizationCode(port, state)` — `src/auth/oauth-flow.ts`; the localhost callback listener.
4. `exchangeCodeForTokens(config, code, verifier, redirectUri, fetch)` — `src/auth/oauth-flow.ts`.
5. `new TokenStore(path, secret).save(...)` — `src/auth/token-store.ts`.

No new HTTP, crypto, or token logic is written.

### How the encryption key matches the server (so tokens load)
`server.ts` constructs `new TokenStore(\`${dataDir}/tokens.enc\`, clientSecret)`, where the AES-256-GCM key is `sha256(clientSecret)` (see `token-store.ts` ctor) and `dataDir = CLAUDE_PLUGIN_DATA ?? '.zendesk-plugin-data'`. For the server to `load()` and refresh what the bin saved, the bin **must** derive the same file path and the same secret.

To guarantee this by construction (not by two copies drifting — the exact class of gap this milestone fixes), extract the config resolution both processes share into `src/auth/config.ts::resolveAuthConfig(env)`, returning `{ config: OAuthConfig, dataDir }` from the same env var names, defaults, and scopes. `server.ts` is refactored to call it; the bin calls it too. Same env in → identical `OAuthConfig` (subdomain / clientId / **clientSecret** / callbackPort / scopes) and `dataDir` → identical `TokenStore(\`${dataDir}/tokens.enc\`, clientSecret)`.

Scopes reuse the server's current `['read', 'write']` (server is the source of truth). See Ambiguity C.

### Testability
`authorize(deps)` takes injected dependencies — a fake `waitForCode`, an injectable `exchange`/`fetchImpl`, deterministic `generateVerifier`/`generateState`/`now`, and a captured `print`. Tests exercise the full happy path and error path with **no real network, no real browser, no real port bind**. The thin `src/bin/authorize.ts` entry just resolves env → real deps → `authorize(...)`.

---

## File structure (M8 delta)

```
zendesk-plugin/
├── LICENSE                                  # NEW — MIT
├── README.md                                # REWRITTEN — release setup/usage/security
├── package.json                             # EDIT — add "bin" + "authorize" script
├── .claude-plugin/
│   ├── plugin.json                          # EDIT (optional) — homepage/repository/keywords
│   └── marketplace.json                     # NEW — single-plugin marketplace, source "./"
├── src/
│   ├── server.ts                            # EDIT — use resolveAuthConfig()
│   ├── auth/
│   │   ├── config.ts                        # NEW — resolveAuthConfig(env) (shared by server + bin)
│   │   └── authorize.ts                     # NEW — authorize(deps) core wiring (reuses pkce/oauth-flow/token-store)
│   └── bin/
│       └── authorize.ts                     # NEW — thin CLI entry → dist/bin/authorize.js
└── tests/
    ├── auth/
    │   ├── config.test.ts                   # NEW
    │   └── authorize.test.ts                # NEW
    └── plugin/
        └── secret-safe-logging.test.ts      # NEW
```

No new runtime dependencies. `src/bin/` and the new `src/auth/*` compile under the existing `tsconfig` (`rootDir: src`, `include: ["src"]`) into `dist/`.

---

## Ordered task list (8 tasks)

### Task 1 — Shared auth-config resolver (TDD) — the key-match guarantee
**Files:** `src/auth/config.ts` (new), `tests/auth/config.test.ts` (new), `src/server.ts` (refactor).

**RED — `tests/auth/config.test.ts`:**
- given full env, `resolveAuthConfig` returns `config.subdomain/clientId/clientSecret` from `ZENDESK_SUBDOMAIN` / `ZENDESK_OAUTH_CLIENT_ID` / `ZENDESK_OAUTH_CLIENT_SECRET`.
- `callbackPort` defaults to `8976`, honors `ZENDESK_OAUTH_CALLBACK_PORT`.
- `scopes` equals `['read', 'write']`.
- `dataDir` defaults to `.zendesk-plugin-data`, honors `CLAUDE_PLUGIN_DATA`.
- each missing required var throws `Missing required environment variable: <NAME>`.

**GREEN — `src/auth/config.ts`:**
```ts
import type { OAuthConfig } from './oauth-flow.js';

const DEFAULT_CALLBACK_PORT = 8976;
const DEFAULT_DATA_DIR = '.zendesk-plugin-data';
const DEFAULT_SCOPES = ['read', 'write'];

export interface ResolvedAuthConfig {
  config: OAuthConfig;
  dataDir: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function resolveAuthConfig(env: NodeJS.ProcessEnv): ResolvedAuthConfig {
  return {
    config: {
      subdomain: required(env, 'ZENDESK_SUBDOMAIN'),
      clientId: required(env, 'ZENDESK_OAUTH_CLIENT_ID'),
      clientSecret: required(env, 'ZENDESK_OAUTH_CLIENT_SECRET'),
      callbackPort: Number(env.ZENDESK_OAUTH_CALLBACK_PORT ?? String(DEFAULT_CALLBACK_PORT)),
      scopes: DEFAULT_SCOPES,
    },
    dataDir: env.CLAUDE_PLUGIN_DATA ?? DEFAULT_DATA_DIR,
  };
}
```

**Refactor `src/server.ts`:** replace the inline `requireEnv` reads for subdomain/clientId/clientSecret/dataDir/callbackPort/scopes with:
```ts
const { config: oauthConfig, dataDir } = resolveAuthConfig(process.env);
const tokenStore = new TokenStore(`${dataDir}/tokens.enc`, oauthConfig.clientSecret);
const authManager = new AuthManager(tokenStore, oauthConfig);
const { subdomain } = oauthConfig;
```
Keep `securityLevel` / `markdownDefault` / `reportConfig` parsing as-is. Do not change behavior — the resolved values must equal today's (verified by the still-green existing server/plugin tests).

**Verify:** `npm test` green (new + existing).

**Commit:** `feat(auth): extract shared OAuth config resolver`

---

### Task 2 — `authorize(deps)` core wiring (TDD)
**Files:** `src/auth/authorize.ts` (new), `tests/auth/authorize.test.ts` (new).

**RED — `tests/auth/authorize.test.ts`** (all deps faked; use a `tmpdir` for `dataDir`):
- happy path: fake `waitForCode` resolves `{ code, redirectUri }`; fake `exchange` returns `{ accessToken, refreshToken, expiresIn: 3600 }`; after `authorize`, a `TokenStore(\`${dataDir}/tokens.enc\`, clientSecret)` `.load()` returns those tokens with `expiresAt === now() + 3600*1000`.
- **CSRF wiring:** the `state` passed to `waitForCode` is the same `state` embedded in the URL built by `buildAuthorizationUrl` (assert by parsing the captured URL's `state` param).
- **verifier↔challenge wiring:** `exchange` receives the same `codeVerifier` whose `generateCodeChallenge` output appears as `code_challenge` in the printed URL.
- **secret-safe:** the concatenation of all captured `print(...)` lines contains **none** of `clientSecret`, `accessToken`, `refreshToken`.
- error path: `waitForCode` rejects → `authorize` rejects, and **no** `tokens.enc` file is written.

**GREEN — `src/auth/authorize.ts`:**
```ts
import { randomBytes } from 'node:crypto';
import { generateCodeVerifier, generateCodeChallenge } from './pkce.js';
import {
  buildAuthorizationUrl,
  waitForAuthorizationCode,
  exchangeCodeForTokens,
  type OAuthConfig,
  type AuthorizationResult,
} from './oauth-flow.js';
import { TokenStore } from './token-store.js';

export interface AuthorizeDeps {
  config: OAuthConfig;
  dataDir: string;
  waitForCode?: (port: number, state: string) => Promise<AuthorizationResult>;
  exchange?: typeof exchangeCodeForTokens;
  generateVerifier?: () => string;
  generateState?: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  print?: (line: string) => void;
}

export async function authorize(deps: AuthorizeDeps): Promise<void> {
  const {
    config,
    dataDir,
    waitForCode = waitForAuthorizationCode,
    exchange = exchangeCodeForTokens,
    generateVerifier = generateCodeVerifier,
    generateState = () => randomBytes(16).toString('base64url'),
    fetchImpl = fetch,
    now = Date.now,
    print = (line) => process.stdout.write(`${line}\n`),
  } = deps;

  const verifier = generateVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = generateState();
  const url = buildAuthorizationUrl(config, challenge, state);

  print('Open this URL in your browser to authorize the Zendesk plugin:');
  print(url);
  print(`Waiting for the callback on http://localhost:${config.callbackPort}/callback ...`);

  const result = await waitForCode(config.callbackPort, state);
  const tokens = await exchange(config, result.code, verifier, result.redirectUri, fetchImpl);

  const store = new TokenStore(`${dataDir}/tokens.enc`, config.clientSecret);
  store.save({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: now() + tokens.expiresIn * 1000,
  });

  print('Authorization complete. Tokens saved securely. You can now use the Zendesk plugin.');
}
```

**Verify:** `npm test` green.

**Commit:** `feat(auth): add first-token authorize wiring`

---

### Task 3 — CLI entry + npm wiring
**Files:** `src/bin/authorize.ts` (new), `package.json` (edit).

**`src/bin/authorize.ts`:**
```ts
#!/usr/bin/env node
import { resolveAuthConfig } from '../auth/config.js';
import { authorize } from './../auth/authorize.js';

async function main(): Promise<void> {
  const { config, dataDir } = resolveAuthConfig(process.env);
  await authorize({ config, dataDir });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Authorization failed: ${message}\n`);
  process.exitCode = 1;
});
```

**`package.json`** — add:
```json
  "bin": { "zendesk-authorize": "dist/bin/authorize.js" },
```
and a script:
```json
    "authorize": "node dist/bin/authorize.js",
```

**Verify (concrete):**
- `npm run build` produces `dist/bin/authorize.js`.
- `ZENDESK_SUBDOMAIN= node dist/bin/authorize.js` (missing required var) exits non-zero and prints `Authorization failed: Missing required environment variable: ZENDESK_SUBDOMAIN` to **stderr** (no secret, no stdout noise). A smoke assertion of this exit path is sufficient; the flow itself is covered by Task 2.

**Commit:** `feat(auth): add zendesk-authorize CLI entry`

---

### Task 4 — OSS license
**File:** `LICENSE` (new). Full MIT text, matching `plugin.json` `"license": "MIT"`, author Persoqua.

```
MIT License

Copyright (c) 2026 Persoqua (r.pfisterer@persoqua.de)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**Verify:** `LICENSE` present at repo root; first line `MIT License`; year 2026; author matches `plugin.json`.

**Commit:** `docs: add MIT license`

---

### Task 5 — `marketplace.json` (+ optional plugin.json metadata)
**Files:** `.claude-plugin/marketplace.json` (new); `.claude-plugin/plugin.json` (optional edit).

Single-plugin marketplace, plugin lives in this repo → `"source": "./"` (mirrors the verified `caveman` local-source pattern; `owner` + `metadata` + `plugins[]` shape mirrors the `superpowers-marketplace` example, which passes `--strict`).

**`.claude-plugin/marketplace.json`:**
```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "zendesk",
  "owner": {
    "name": "Persoqua",
    "email": "r.pfisterer@persoqua.de"
  },
  "metadata": {
    "description": "Full-spectrum Zendesk integration for Claude Code — tickets, users, business rules, Guide, analytics.",
    "version": "0.1.0"
  },
  "plugins": [
    {
      "name": "zendesk",
      "source": "./",
      "description": "Manage Zendesk tickets, users, organizations, business rules, and Help Center content from Claude Code.",
      "category": "productivity"
    }
  ]
}
```

**Optional `plugin.json` metadata** (recognized fields per the `superpowers` plugin.json; free discoverability for a public release, keeps `--strict` green):
```json
  "homepage": "https://github.com/PersoQua-AG/zendesk-plugin",
  "repository": "https://github.com/PersoQua-AG/zendesk-plugin",
  "keywords": ["zendesk", "support", "helpdesk", "tickets", "mcp"],
```

**Verify (concrete):**
- `claude plugin validate --strict .claude-plugin/marketplace.json` → `Validation passed`.
- `claude plugin validate --strict .` (plugin) still passes after any plugin.json edit.
- If `--strict` flags any field, adjust to the schema and re-run (this is the M8 "get `--strict` passing" deliverable; plain + strict already pass today, so this is a keep-green + validate-the-new-file task, not a fix-up).

**Commit:** `feat: add plugin marketplace descriptor`

---

### Task 6 — Secret-safe logging audit (TDD)
**File:** `tests/plugin/secret-safe-logging.test.ts` (new). Fix any leak found.

Rationale: the MCP server's **stdout is the MCP stdio transport** — any stray stdout write corrupts the protocol, and secrets must never reach any log sink. Baseline audit found only one logging call in `src/` (`console.warn` in `analytics/business-hours.ts`, a config-parse warning to **stderr** — safe) and no `console.log`.

**Tests:**
- **Static guard:** walk `src/**/*.ts`; assert **no** occurrence of `console.log(` and no `process.stdout.write` in any module the *server* loads (allowlist `src/bin/**` and `src/auth/authorize.ts`, which are the standalone CLI, not the server process). Fails the build if a future `console.log` sneaks into a server path.
- **No-secret-in-error guard:** drive `exchangeCodeForTokens` / `refreshAccessToken` with an injected `fetchImpl` returning `{ ok: false, status: 400, text: () => 'invalid_grant' }` and a config whose `clientSecret` is a sentinel (`'SENTINEL_SECRET'`); assert the thrown `Error.message` does **not** contain `'SENTINEL_SECRET'`. (Current code interpolates the response body, not the secret — this test documents and locks that.)
- **AuthManager guard:** assert the "could not be read" / "No Zendesk authorization found" error messages contain no token material (they don't today).

**Fix:** only if a test goes red. Expected: all green with no source change (audit confirms clean).

**Commit:** `test: guard against secret leakage and stray stdout`

---

### Task 7 — Release README
**File:** `README.md` (rewrite). Full content below — no placeholders except screenshots (images cannot be generated here; marked as text placeholders per the brief).

````md
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
[PRD](docs/superpowers/specs/2026-07-09-zendesk-plugin-prd.md §6) for the full
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
claude plugin validate --strict .
```

## Documents

- [PRD](docs/superpowers/specs/2026-07-09-zendesk-plugin-prd.md)
- [Foundation plan (M0+M1)](docs/superpowers/plans/2026-07-09-zendesk-plugin-foundation.md)
- [Packaging plan (M8)](docs/superpowers/plans/2026-07-23-packaging.md)

## License

[MIT](LICENSE) © Persoqua
````

**Verify (concrete):** all sections present; the authorize command matches the
`package.json` `authorize` script; the redirect URI matches the default port;
no stale "see follow-up milestone" text remains; the userConfig table matches
`plugin.json`.

**Commit:** `docs: rewrite README for public release`

---

### Task 8 — Release gate (full suite + build + strict validate)
**No new files.** The final acceptance gate for the whole plugin (all milestones together):

```bash
npm run build \
  && npm test \
  && claude plugin validate --strict . \
  && claude plugin validate --strict .claude-plugin/marketplace.json
```

**Pass criteria:** build clean; **all** tests green (389 existing + the new
config/authorize/secret-safe tests); both strict validations pass. This is the
contract/full-suite green deliverable (PRD §9 M8, §10). No commit (verification
only); if anything is red, fix under the owning task and re-run.

---

## Self-review

### Coverage vs PRD §9 M8 line
| §9 M8 item | Task | Status |
|---|---|---|
| README + setup/screenshots | 7 | Full README; screenshots = explicit text placeholders (cannot generate images) |
| OSS license | 4 | Full MIT `LICENSE` |
| `claude plugin validate --strict` | 5, 8 | Already passes; kept green + new marketplace.json validated strict |
| `marketplace.json` | 5 | Full single-plugin descriptor, `source: "./"` |
| secret-safe logging | 6 | Static stdout/`console.log` guard + no-secret-in-error tests; audit found clean |
| contract/full suite green | 8 | Build + full vitest + strict ×2 gate |
| **Completeness fix:** OAuth first-token setup | 1–3 | `resolveAuthConfig` + `authorize(deps)` + `zendesk-authorize` bin, pure wiring |

### Placeholder scan
Every deliverable is full content: `LICENSE` (full MIT), `marketplace.json`
(full), README (full), authorize/config/bin (full runnable TS). The **only**
placeholders are the README screenshots, explicitly permitted by the brief
because images cannot be generated in this environment.

### `--strict` readiness
Plain and strict both pass on the current `plugin.json` today (verified). New
`plugin.json` fields (homepage/repository/keywords) are the recognized fields a
real strict-passing plugin (`superpowers`) uses. The new `marketplace.json`
mirrors two known-good examples and is itself validated with `--strict` in Tasks
5 and 8; if the schema flags a field, adjust and re-run — no runtime change
needed.

### Ponytail check
- Zero new dependencies (uses `node:http`, `node:crypto`, and existing modules).
- Zero new crypto/flow logic — the bin is pure composition of `pkce` +
  `oauth-flow` + `token-store`.
- The shared `resolveAuthConfig` removes duplicated env-parsing rather than
  adding a second copy — the lazier *and* the correct choice; it is what makes
  the bin's encryption key/path provably match the server's.
- Minimal CLI: prints the URL, no browser auto-open, no arg-parsing framework.
- No API-token fallback, no multi-account, no speculative abstraction.

---

## Ambiguities for orchestrator (defaults proposed)

- **A. `dist/` is gitignored, but `plugin.json` `mcpServers` runs `dist/server.js`.**
  Pre-existing from M0–M7; M8 inherits it (the bin follows the same convention).
  **Default:** document `npm install && npm run build` as the install step (done
  in README Task 7) and keep `dist/` gitignored. If the marketplace install does
  **not** run a build, `dist/` must instead be committed (drop it from
  `.gitignore`) — flag for a distribution-mechanics decision, but do **not**
  expand M8 scope to solve it speculatively.
- **B. Marketplace name.** **Default:** `"zendesk"` (same as the plugin name;
  the `caveman` example does exactly this). Rename to `"persoqua"` only if the
  org prefers a vendor-scoped marketplace.
- **C. OAuth scopes.** Server hardcodes `['read', 'write']`; PRD §5.1 lists
  granular scopes (`tickets:* users:* hc:* triggers:read …`). **Default:** reuse
  `['read', 'write']` so the token the bin obtains exactly matches what the
  server refreshes (server is the source of truth). Widen only if a tool hits a
  scope error in live testing.
- **D. API-token fallback (PRD §5.1, optional/internal).** Not in `userConfig`
  today and not required for a valid OAuth release. **Default:** OAuth-only for
  this release; defer the fallback.
- **E. Browser auto-open in the bin.** **Default:** print the URL only (no `open`
  dependency, no platform branching). Add auto-open later only if requested.
