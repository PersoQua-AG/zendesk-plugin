# M9 — Remote Zendesk MCP Connector for claude.ai (Requirements)

- **Date:** 2026-07-30
- **Milestone:** M9 (follows M8 packaging)
- **Author role:** Requirements Engineer (spec only — no code, no PR)
- **Repo:** `PersoQua-AG/zendesk-plugin` (MIT, public)
- **Status:** Review-ready. Contains BLOCKING decisions (see §9) that must be resolved before slicing into issues.

> Scope note: M9 changes **transport + auth-session + hosting** only. The 64-tool
> surface, screening pipeline, write-safety helpers, rate limiting, cache, and
> Markdown conversion are **reused unchanged**. Every requirement below traces to
> a real symbol in this repo (§8).

---

## 1. Epic

**Problem.** The working Zendesk plugin is a local **stdio** MCP server
(`src/server.ts` connects `StdioServerTransport` at the entrypoint guard, lines
74–77). It runs only inside Claude Code (terminal/desktop/IDE). The claude.ai
**web / Co-Work GUI does not run local Claude Code plugins** — it only loads
**connectors** (remote MCP servers registered in the connector registry).
Confirmed empirically: a tool-search for "zendesk" in the GUI returns nothing.
PersoQua's support/ops staff — many without GitHub or a terminal, some
non-technical — therefore cannot use Zendesk from the GUI.

**Decision.** Add a **remote MCP entrypoint** over Streamable HTTP/SSE that
reuses the existing tool registrations (`createServer(env)` in `src/server.ts`
already builds and fully wires the server *without* connecting a transport,
lines 46–70 — the reuse seam), host it on an always-on, claude.ai-reachable
endpoint, and register it as a claude.ai custom connector enabled org-wide by
the Claude-for-Teams/Enterprise Owner.

**Target outcome.** A non-technical PersoQua colleague, in the claude.ai GUI,
can (a) run read-only KPI reports on funding-application outcomes and (b) update
a ticket's funding-status custom field — with the **same** guardrails the stdio
plugin enforces (confirm-before-write, `safe_update` optimistic concurrency, no
destructive ops, prompt-injection screening), against PersoQua's Zendesk holding
applicant PII, under GDPR-appropriate data handling.

**Success metric.** From a standing start (Owner has enabled the connector), a
support colleague with no terminal completes both a funding-KPI report and a
single funding-status field update through the GUI, end-to-end, with correct
per-action attribution in Zendesk audit logs, and zero secrets/PII in server
logs — verified in one live acceptance session against
`kundenservicepersoqua.zendesk.com`.

---

## 2. User stories (INVEST)

Priority: P0 = release-blocking, P1 = needed for a usable rollout, P2 = follow-up.

| ID | Story | Pri |
|----|-------|-----|
| **REQ-1** | As a maintainer, I want a **remote HTTP/SSE entrypoint** that reuses `createServer()`'s tool registration, so the remote connector exposes the identical 64-tool surface with no tool rewrite. | P0 |
| **REQ-2** | As a maintainer, I want the **tool surface proven identical** to the stdio plugin (names, input schemas, count), so remote ≠ a divergent fork. | P0 |
| **REQ-3** | As the Claude Owner, I want the server to expose the **OAuth + discovery endpoints claude.ai requires of a custom connector**, so I can register and enable it org-wide. | P0 |
| **REQ-4** | As a security owner, I want a decided **auth identity model** (per-user Zendesk OAuth vs single shared service account) with server-side token handling matching that choice, so actions are attributed and least-privilege. *(Depends on BLOCKING decision D1.)* | P0 |
| **REQ-5** | As a support colleague, I want to **run funding-KPI reports read-only in the GUI**, so I can report Bewilligt/Abgelehnt/… counts without a terminal. | P0 |
| **REQ-6** | As a support colleague, I want to **update a ticket's funding-status custom field via Claude in the GUI**, with confirm-before-write and `safe_update`, so I can maintain records safely. | P0 |
| **REQ-7** | As a security owner, I want **prompt-injection screening to carry over unchanged to the remote path**, so attacker-controlled ticket text cannot hijack the model in the GUI. | P0 |
| **REQ-8** | As a data-protection owner, I want **PII/secret handling for the remote server** (no secrets/PII in logs, encrypted token storage server-side, EU data residency, TLS), so GDPR obligations for applicant data are met. | P0 |
| **REQ-9** | As an ops owner, I want an **always-on, TLS, claude.ai-reachable deployment** with health checks, so the connector is reliable. *(Depends on BLOCKING decision D2.)* | P0 |
| **REQ-10** | As a security owner, I want **least-privilege OAuth scopes and a write-audit trail** for the remote path, so writes are traceable and reads cannot be escalated to writes. | P1 |
| **REQ-11** | As a maintainer, I want a **remote release gate** (build clean, full suite green, remote-transport integration test, no stale stdio-only assumptions), so M9 ships without regressing M0–M8. | P0 |
| **REQ-12** | As a colleague, I want **clear session/auth failure messaging in the GUI** (not-authorized, token-expired, revoked, scope-insufficient), so I know how to recover. | P1 |
| **REQ-13** | As an ops owner, I want **per-user session isolation** so one user's tokens/cache/rate budget never leak into another user's session. *(Only fully applicable under per-user auth D1.)* | P1 |

---

## 3. Acceptance criteria (Gherkin)

### REQ-1 — Remote HTTP/SSE entrypoint reusing `createServer()`
```
Scenario: Remote entrypoint serves MCP over Streamable HTTP
  Given the remote server process is started
  When an MCP client completes initialize over Streamable HTTP/SSE
  Then the server responds with protocol + capabilities
  And it exposes tools registered by the same register* functions server.ts uses
  And no tool file under src/tools/** or src/register/** was modified to achieve this

Scenario: stdio entrypoint still works (no regression)
  Given the same build
  When run as `node dist/server.js` (process entrypoint)
  Then it still connects StdioServerTransport and serves the 64 tools

Scenario (negative): malformed session/initialize
  Given a client sends a malformed or out-of-order MCP frame
  When the server processes it
  Then it returns a protocol error and does not crash the process or other sessions

Scenario (negative): oversized / unsupported content type
  Given a request body exceeds the configured limit or has a wrong content type
  When received
  Then the server rejects it with a 4xx and logs no body content
```

### REQ-2 — Tool surface proven identical
```
Scenario: tool inventory parity
  Given the remote server and a reference stdio server built from the same commit
  When both list tools
  Then the set of tool names is identical
  And each tool's input schema (JSON Schema) is byte-equal
  And the count equals the documented 64

Scenario (negative): drift is caught
  Given a future change adds/removes/renames a tool on only one transport
  When the parity test runs
  Then the build fails
```

### REQ-3 — claude.ai custom-connector registration surface
```
Scenario: connector discovery + OAuth authorize/token endpoints present
  Given claude.ai attempts to register the remote MCP server as a custom connector
  When it performs OAuth discovery / dynamic client handshake and the authorize→callback→token exchange
  Then the server exposes the endpoints claude.ai requires (see ASSUMPTION A3)
  And a successful authorize yields a working authenticated MCP session

Scenario: Owner enables org-wide
  Given the Owner has added the connector
  When it is enabled for the organization
  Then an ordinary member sees "zendesk" in the GUI connector/tool list

Scenario (negative): unauthenticated session
  Given a client opens an MCP session without completing connector OAuth
  When it calls any zendesk_* tool
  Then the call is rejected as unauthorized and no Zendesk API call is made

Scenario (negative): redirect/callback mismatch
  Given the OAuth callback state or redirect URI does not match
  When the callback is received
  Then the exchange is refused (reuse the CSRF/state discipline of oauth-flow.ts)
```

### REQ-4 — Auth identity model (decision-gated)
```
# Option A — per-user Zendesk OAuth (attribution + least privilege)
Scenario: each user acts as themselves
  Given per-user auth is the chosen model
  And user U completed the Zendesk OAuth connector flow
  When U calls zendesk_get_me
  Then the identity returned is U's Zendesk user
  And Zendesk audit records attribute U's writes to U

Scenario: server stores per-user tokens, keyed and isolated
  Given user U's tokens
  Then they are stored server-side encrypted, keyed by U's connector identity
  And are never usable by another session

# Option B — single shared service account (simpler, one identity)
Scenario: all users act as the service account
  Given the service-account model is chosen
  When any user performs a write
  Then Zendesk attributes it to the single service identity
  And the server records the initiating claude.ai user in its own write-audit log (REQ-10)

Scenario (negative, both options): token refresh failure
  Given a stored refresh token is invalid/revoked
  When a tool needs a Zendesk access token
  Then the user sees an actionable re-authorize message (reuse AuthManager.loadFromStore semantics)
  And no partial/garbage request is sent to Zendesk
```

### REQ-5 — Funding-KPI reporting (read-only, GUI)
```
Scenario: count funding outcomes over a range
  Given a colleague asks for funding-application outcomes for a period
  When Claude runs read-only analytics/search tools (e.g. zendesk_report, zendesk_search)
  Then it returns counts grouped by the funding-status custom field values (Bewilligt/Abgelehnt/…)
  And no write tool is invoked

Scenario (negative): no matching data
  Given the range/filter matches no tickets
  Then the tool returns an explicit empty/zero result, not an error and not fabricated numbers

Scenario (negative): result exceeds Zendesk search cap
  Given a query would exceed Zendesk's 1000-result search cap
  Then the tool surfaces the cap (existing behavior) rather than silently truncating
```

### REQ-6 — Funding-status field update (write, GUI, safe)
```
Scenario: confirm-before-write update of the funding-status custom field
  Given a colleague asks to set a ticket's "Status der Förderung" to Bewilligt
  When Claude prepares the update via the ticket-update tool (custom_fields:[{id,value}])
  Then it presents the intended change for confirmation before persisting
  And on confirmation it issues the update with safe_update optimistic concurrency

Scenario (negative): concurrent modification (409 conflict)
  Given the ticket changed since it was read
  When the update is attempted with safe_update
  Then a 409 triggers re-fetch → screened current state → conflict result (no blind overwrite)
  (reuse safeUpdateWithConflict in src/tools/write-helpers.ts)

Scenario (negative): no destructive operation is exposed
  Given a colleague asks to delete/merge/redact a ticket
  Then no such tool exists to satisfy it (enforced by omission — unchanged from stdio)

Scenario (negative): empty update
  Given an update with no changed fields
  Then it is rejected before any PUT (reuse updateEntity empty-guard)
```

### REQ-7 — Screening carries over to the remote path
```
Scenario: inbound ticket content is screened remotely
  Given a ticket body contains an injection string (e.g. "ignore all previous instructions")
  When a GUI user reads it via a remote tool
  Then the content is screened and wrapped in session-scoped nonce delimiters
  And the summary carries the SCREEN_WARNING (reuse security/screen.ts + screening.ts)

Scenario: security level is configured on the remote server
  Given ZENDESK_SECURITY_LEVEL is set for the deployment
  Then the remote ToolContext.securityLevel equals it (default 'standard')

Scenario (negative): screening cannot be disabled per-request by untrusted input
  Given ticket content attempts to alter behavior
  Then only server config, never ticket content, controls the security level
```

### REQ-8 — PII / secret handling (remote)
```
Scenario: no secrets or PII in logs
  Given any request/refresh/error at runtime
  When the server logs
  Then logs contain no client secret, no access/refresh token, and no ticket PII bodies
  (extend the M8 secret-safe-logging guarantee to the remote entrypoint)

Scenario: tokens encrypted server-side at rest
  Given per-user or service tokens are persisted
  Then they are encrypted at rest (AES-256-GCM as in token-store.ts) with a server-held key
  And are readable only by the server process

Scenario: EU data residency + TLS
  Given the deployment
  Then it terminates TLS (>=1.2) and processes/stores data in an EU region (ASSUMPTION A6)

Scenario (negative): token-store integrity failure
  Given the encryption key rotated or a token blob is tampered
  Then decrypt fails closed with a re-authorize message, never a raw crash or plaintext leak
```

### REQ-9 — Always-on reachable deployment
```
Scenario: health check
  Given the deployment
  When a health probe hits the health endpoint
  Then it returns healthy while the MCP server is serving

Scenario: claude.ai reachability
  Given claude.ai's connector infrastructure
  When it connects to the public HTTPS endpoint
  Then the connection succeeds from claude.ai's network (public, TLS, stable hostname)

Scenario (negative): restart resilience
  Given the process restarts
  Then persisted tokens survive (no forced full re-auth of every user on every deploy)
```

### REQ-10 — Least-privilege scopes + write audit
```
Scenario: read-only sessions cannot write
  Given the KPI/reporting use is read-only
  When scopes are provisioned
  Then the minimum scopes needed are requested (see ASSUMPTION A5 / PRD §5.1)

Scenario: every write is audited
  Given a write tool succeeds
  Then the server records an audit entry: initiating claude.ai user, tool, target id, timestamp, outcome
  And the entry contains no PII body and no secret
```

### REQ-11 — Remote release gate
```
Scenario: green gate
  When `npm run build && npm test` runs
  Then build is clean and the full suite is green (M0–M8 tests + new remote tests)

Scenario: remote transport integration test
  Given the remote entrypoint
  When an in-process MCP client initializes over the HTTP transport and lists/calls a tool
  Then it succeeds against a mocked Zendesk client (no live network)

Scenario: no dangling stdio-only assumptions
  Given a repo-wide check
  Then no code path assumes a single process-global token store when per-user auth is selected (D1)
```

### REQ-12 — GUI auth/session failure messaging
```
Scenario: not yet authorized
  When a user calls a tool before completing connector OAuth
  Then the GUI shows a clear "authorize the Zendesk connector" message

Scenario: expired/revoked
  When the Zendesk token is expired/revoked and refresh fails
  Then the GUI shows an actionable re-authorize message (not a stack trace)

Scenario: scope∩role insufficient
  When an admin-gated write is attempted without the role
  Then the existing withAdminGuard message surfaces to the GUI user
```

### REQ-13 — Per-user session isolation
```
Scenario: no cross-user leakage
  Given users U1 and U2 have concurrent sessions (per-user model)
  Then U1's tokens, response cache handles, and rate budget are never observable to U2

Scenario (negative): cache handle reuse across users
  Given U1 obtained a cache handle
  When U2 references that handle
  Then U2 cannot read U1's cached payload
```

---

## 4. Acceptance tests

| AC group | Test type | Target / pattern |
|----------|-----------|------------------|
| REQ-1 remote init + stdio unchanged | integration + unit | new `tests/server-remote/*.test.ts`; mirror `tests/server.test.ts` (imports `createServer`), use SDK `streamableHttp` transport with an in-memory pair |
| REQ-2 tool parity | unit (contract) | new `tests/server-remote/tool-parity.test.ts`: list tools from remote vs stdio-built `createServer`, assert equal names + JSON Schemas + count=64 |
| REQ-3 connector OAuth/discovery | integration + manual | unit-test the OAuth endpoints (reuse SDK `server/auth`); **manual** live registration in claude.ai by Owner (records the exact requirements → closes A3) |
| REQ-4 identity model | unit + integration | per-user: `tests/auth/remote-token-store.test.ts` (keyed, isolated); service-account: identity assertion; both: refresh-failure path (mirror `tests/auth/auth-manager.refresh-failure.test.ts`) |
| REQ-5 KPI read-only | integration | `tests/tools/*` pattern with mocked client; assert grouping by custom field + no write tool called + empty/zero + 1000-cap surfaced |
| REQ-6 safe write | unit | mirror existing write-helper tests; assert confirm-gate contract, safe_update attached, 409→conflict, empty-guard, no destructive tool present |
| REQ-7 screening remote | unit | reuse `tests/security/screen.test.ts` assertions on the remote ctx; assert `securityLevel` wired from env |
| REQ-8 PII/secret | unit + manual | extend `tests/plugin/secret-safe-logging.test.ts` to remote entrypoint + logger; **manual** residency/TLS verification of the chosen host |
| REQ-9 deployment | manual + build-gate | health endpoint unit test; manual claude.ai reachability + restart-persistence check |
| REQ-10 scopes + audit | unit | audit-entry shape test (no PII/secret); scope config test |
| REQ-11 release gate | build-gate | `npm run build && npm test`; new remote integration test included |
| REQ-12 failure messaging | unit | assert error-to-user mapping strings (reuse AuthManager/withAdminGuard messages) |
| REQ-13 isolation | integration | two concurrent sessions; assert token/cache/rate isolation (per-user model) |

**Build-gate (mandatory):** clean `tsc` build, full `vitest` suite green, remote
integration test green, and a repo-wide grep proving no live code path silently
reuses a single global `TokenStore` when per-user auth is selected.

---

## 5. Non-functional requirements

- **Availability:** always-on; target ≥99% monthly; health endpoint; auto-restart; token persistence survives restarts (REQ-9).
- **Security/transport:** public HTTPS, TLS ≥1.2, stable hostname; connector OAuth required before any tool call; CSRF/state validation carried from `oauth-flow.ts`.
- **PII / data protection (GDPR):** EU processing + storage region (A6); no PII bodies in logs; tokens encrypted at rest (AES-256-GCM); data-retention policy for server-side token store and any audit log (retention window = OPEN, A7); right-to-erasure path for stored per-user tokens.
- **Secrets:** client secret + tokens never logged; server-held encryption key from a secrets manager, not source.
- **Observability:** structured logs (request id, tool name, outcome, latency) with PII/secret redaction; write-audit log (REQ-10); no `console.log` on server path (extend M8 static guard).
- **Idempotency/consistency:** writes use `safe_update` optimistic concurrency; reads honor existing eventual-consistency + 1000-result-cap behavior; rate limiting reuses the 400/min + 10/min incremental buckets — **per-identity budgeting is an open item** under per-user auth (A8).
- **Localization:** German-language funding field values (Bewilligt/Abgelehnt/Sammelantrag QCG/EGZ) handled as opaque values; no hardcoded English assumptions in reporting.
- **Accessibility:** interaction is via the claude.ai GUI (Anthropic-owned); no separate UI shipped — N/A for us beyond clear text messages (REQ-12).
- **Performance budget:** tool round-trip dominated by Zendesk API; server overhead target <200 ms p95 excluding upstream.

---

## 6. Out of scope

- Rewriting or expanding the 64 tools; adding new Zendesk capabilities.
- Adding **destructive** operations (delete/merge/redact/spam) — remains enforced by omission.
- Deprecating or removing the stdio/Claude Code plugin — it stays.
- Building a custom UI/frontend (claude.ai provides the GUI).
- SSO/SCIM/user-provisioning for PersoQua staff beyond what the connector OAuth flow needs.
- Multi-Zendesk-instance / multi-tenant hosting beyond PersoQua's single subdomain.
- The Microsoft 365 bridge over the remote transport (defer unless requested).
- Automated funding decisions or business logic — the tool only reports/sets fields a human directs.

---

## 7. Dependencies & sequencing

1. **D1 auth-model decision (BLOCKING)** gates REQ-4, REQ-13, and the storage design of REQ-3/REQ-8. Resolve first.
2. **D2 hosting decision (BLOCKING)** gates REQ-9, and the residency/TLS specifics of REQ-8. Resolve early (parallel to D1).
3. **REQ-1 remote entrypoint** is the foundation; can start immediately (reuses `createServer`), independent of D1/D2 for the transport shell.
4. **REQ-2 parity** depends on REQ-1.
5. **REQ-3 connector OAuth** depends on REQ-1 + D1 (token session model) and A3 (claude.ai's exact requirements — confirm via a live Owner registration).
6. **REQ-4** depends on D1.
7. **REQ-5/REQ-6/REQ-7** depend on REQ-1 (they reuse tools once a session exists); functionally unchanged from stdio, so low risk once transport + auth land.
8. **REQ-8** spans REQ-3/REQ-4/REQ-9; finalize once D1+D2 are set.
9. **REQ-9** depends on D2.
10. **REQ-11 gate** last.
- **Can ship independently / first:** REQ-1, REQ-2 (transport shell + parity) before the auth/hosting decisions are finalized, using a dev-only single-token config.

---

## 8. Traceability matrix

| Story | ACs | Tests | Component / real symbol |
|-------|-----|-------|-------------------------|
| REQ-1 | remote init, stdio unchanged, malformed, oversized | integration+unit | new HTTP entrypoint calling `createServer()` (`src/server.ts` 46–70); reuse `@modelcontextprotocol/sdk/.../streamableHttp.js` (present in installed SDK) |
| REQ-2 | inventory parity, drift caught | contract | all `src/register/*.ts` registrars; `McpServer` in `src/server.ts` |
| REQ-3 | discovery+OAuth, org enable, unauth, redirect mismatch | integration+manual | `src/auth/oauth-flow.ts` (state/CSRF, exchange); SDK `server/auth`; new session layer |
| REQ-4 | per-user, service-account, refresh failure | unit+integration | `src/auth/auth-manager.ts`, `src/auth/token-store.ts`, `src/auth/config.ts` (per-user keying = the change) |
| REQ-5 | counts, empty, 1000-cap | integration | `src/register/analytics.ts` (`zendesk_report`), `src/register/search.ts` |
| REQ-6 | confirm, 409, no-destructive, empty | unit | `src/tools/write-helpers.ts` (`safeUpdateWithConflict`, `updateEntity`), `src/register/tickets.ts:23` (`custom_fields`), `src/tools/tickets.ts:140` |
| REQ-7 | screened, level config, cannot disable | unit | `src/security/screen.ts`, `src/tools/screening.ts`, `ToolContext.securityLevel` (`src/register/context.ts`) |
| REQ-8 | no-log, encrypted, EU+TLS, integrity fail | unit+manual | `src/auth/token-store.ts` (AES-256-GCM), `tests/plugin/secret-safe-logging.test.ts`, host config |
| REQ-9 | health, reachability, restart | manual+build | deployment (D2); persistence layer of REQ-4 |
| REQ-10 | read-only, audit | unit | scope config (`src/auth/config.ts` `DEFAULT_SCOPES`), new audit logger |
| REQ-11 | green, remote integ, no dangling | build-gate | `package.json` scripts; new `tests/server-remote/*` |
| REQ-12 | not-auth, expired, scope | unit | `AuthManager.loadFromStore` messages, `withAdminGuard` (`write-helpers.ts`) |
| REQ-13 | no leakage, cache handle | integration | per-user `TokenStore`/`ResponseCache` keying; `src/client/cache.ts` |

---

## 9. Assumptions & open questions

### BLOCKING decisions (must be resolved by the requester before issues)
- **D1 — Auth identity model.** Per-user Zendesk OAuth **vs** single shared service account.
  - *Per-user:* correct attribution in Zendesk audit logs + least privilege per user; **cost:** server-side per-user encrypted token store keyed by connector identity, a connector OAuth flow per user, session isolation (REQ-13), GDPR erasure per user.
  - *Service account:* simplest to build/host (one token, near-M8 storage); **cost:** every action attributed to one identity → no per-user Zendesk audit trail (mitigated only by our own write-audit log, REQ-10), broader blast radius if the single token leaks, no per-user least privilege.
  - **Recommendation to state, not to decide:** per-user is the correct model for PII + attribution; service account only as an interim if per-user OAuth registration blocks the timeline. **REQUESTER MUST DECIDE.**
- **D2 — Hosting.** Cloudflare Worker vs Fly.io vs PersoQua's own infra. Must be always-on, public HTTPS/TLS, claude.ai-reachable, **EU region**, with a secrets manager for the encryption key + client secret, and persistence that survives restarts (rules out purely ephemeral edge storage unless paired with a durable EU-region store). **REQUESTER MUST DECIDE** (region + persistence are the constraints, not the vendor).
- **D3 — PII/region confirmation.** Confirm the Zendesk instance and all M9 processing/storage stay in the EU and that GDPR (not just internal policy) governs; confirm a data-retention window for server-side tokens and the write-audit log (A7).

### Assumptions (with defaults — flagged where they change ACs)
- **A1.** `createServer(env)` (already transport-agnostic) is the sole reuse seam; the remote entrypoint adds an HTTP transport, changing no tool file. *(Verified in source.)*
- **A2.** Installed SDK `^1.29.0` ships `streamableHttp` + `sse` + `server/auth`, so no new MCP dependency is needed. *(Verified: files present in `node_modules`.)*
- **A3.** claude.ai custom connectors require: a public HTTPS MCP endpoint, OAuth 2.0 authorize/token endpoints (likely with discovery / dynamic client registration), and Owner org-enablement. **The exact contract will be confirmed by a live Owner registration** (REQ-3 manual test) — a change here can alter REQ-3 ACs.
- **A4.** The funding outcome is a **ticket custom field** (`custom_fields:[{id,value}]`); the specific field id(s) and allowed values (Bewilligt/Abgelehnt/Sammelantrag QCG/EGZ/…) will be provided from Zendesk admin config. *(Write path verified: `register/tickets.ts:23`.)*
- **A5.** Reporting is achievable read-only via existing analytics/search tools; if grouping by the custom field needs a shape the current `zendesk_report` doesn't emit, that is a **reporting-capability question**, not an M9 transport change — flag if it surfaces.
- **A6.** Data residency = EU (German funding context). Default region: EU (e.g. `eu-central`/Frankfurt). Confirm with D3.
- **A7.** Retention: default 90 days for the write-audit log and "until revoke/rotate" for tokens; **confirm** — changes REQ-8/REQ-10 ACs.
- **A8.** Rate-limit buckets (400/min, 10/min incremental) are **account-wide**; under per-user auth many users share the Zendesk account budget. Default: keep account-wide buckets; per-identity fairness is a P2 follow-up. Flag if concurrency causes 429 storms.
- **A9.** The Owner (a specific person, not the requester) will perform the org-wide enablement; the requester coordinates. This is an operational dependency, not a code requirement.
- **A10.** Output of this doc is saved in-repo (per task instruction) rather than the hub OPS workspace, because M9 lives in the `zendesk-plugin` repo alongside the M8 plan.

**None of the BLOCKING decisions are resolved here. Do not slice REQ-3/REQ-4/REQ-9 into issues until D1, D2, D3 are answered.**
