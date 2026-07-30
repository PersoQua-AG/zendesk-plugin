# M9 — Remote Zendesk MCP Connector for claude.ai (Implementation Plan)

- **Date:** 2026-07-30
- **Milestone:** M9 (follows M8 packaging)
- **Repo:** `PersoQua-AG/zendesk-plugin` · branch `spec/m9-remote-connector`
- **Spec:** `docs/superpowers/specs/2026-07-30-m9-remote-connector-requirements.md` (REQ-1..13)
- **Epic:** GitHub issue #4
- **Discipline:** ponytail. Reuse the existing 64-tool core untouched; add the smallest possible new surface. Every task is TDD (RED → GREEN → REFACTOR) in the existing **vitest** harness. No new runtime dependency.

> Golden constraint (REQ-1/REQ-2): **no file under `src/tools/**` or `src/register/**` is modified.** The only edits to existing `src/**` are two seam files (`src/client/http-client.ts`, `src/server.ts`), both behaviour-preserving for the stdio entrypoint. Everything else is additive under `src/remote/**`, `src/auth/**` (new files), `src/bin/`, `deploy/`, and `tests/**`.

---

## 0. Resolved decisions this plan builds to (do NOT re-open)

- **D1 — Auth = per-user OAuth.** Server-side, per-user, AES-256-GCM-encrypted Zendesk-token store keyed by connector user identity. Each user runs the Zendesk OAuth (PKCE) flow through the connector. We reuse `oauth-flow.ts` + `token-store.ts` and generalize the single `AuthManager`/`TokenStore` into a per-identity resolver injected into `http-client.ts`.
- **D2 — Hosting = PersoQua-controlled EU VM.** Dockerfile + `docker compose` run unit (systemd unit provided as alternative), TLS terminated at a reverse proxy, EU region. No serverless / no ephemeral edge storage.
- **D3 — PII/region = EU-only, GDPR, 90-day retention** for the per-user token store and the write-audit log (or until revoke). Screening (`security/screen.ts`) + write guards (`safe_update`, confirm-before-write, no destructive ops) carry over unchanged to the remote path.

---

## 1. Architecture — the reuse seam and the one change that matters

The stdio server is already transport-free at the wiring layer:

```
createServer(env)  →  builds AuthManager (single identity) + rate buckets + cache + ctx + registers 64 tools
                      returns { server, ctx, ... }  — NO transport attached
entrypoint guard   →  stdio only:  server.connect(new StdioServerTransport())
```

M9 keeps `createServer()` as the sole reuse seam and changes exactly **one conceptual thing**: the token identity flows from *one global `AuthManager`* to *one `AuthManager` per connector user*, resolved per MCP session.

### 1.1 The single-identity seam → per-identity

`ZendeskHttpClient` today holds a concrete `AuthManager` and calls `authManager.getAccessToken()`. That is the entire coupling. We narrow the dependency to an interface:

```ts
export interface TokenProvider { getAccessToken(): Promise<string>; }
```

`AuthManager` already satisfies it (its `getAccessToken(): Promise<string>` is unchanged). The http-client stores a `TokenProvider` instead of an `AuthManager`. Nothing else in the client changes — same rate buckets, same retry, same error mapping.

Per user, we build a `TokenProvider` = an `AuthManager` over that user's own `TokenStore` file (`users/<sha256(identity)>.enc`), AES-256-GCM as today. A remote MCP session is bound to one identity, so it gets one per-user `AuthManager`, injected into `createServer(env, deps)`.

```
claude.ai (MCP client)
   │  Bearer <opaque access token issued by OUR server>
   ▼
Remote entrypoint (express)
   ├─ mcpAuthRouter  ......... OAuth AS endpoints (discovery/authorize/token/register/revoke)  ← SDK
   ├─ requireBearerAuth ...... verifies our opaque token → AuthInfo{ extra.identity }          ← SDK
   └─ per session:
        identity = authInfo.extra.identity
        authManager = IdentityAuthResolver.forIdentity(identity)      // per-user Zendesk tokens (encrypted)
        { server } = createServer(env, { authManager, rateLimiter: SHARED, incrementalRateLimiter: SHARED, cache: perUserCache })
        server.connect(new StreamableHTTPServerTransport({ sessionIdGenerator }))
   ▼
ZendeskHttpClient (unchanged behaviour) → https://kundenservicepersoqua.zendesk.com
```

Rate limiters are **shared singletons** across sessions on purpose: the Zendesk 400/min + 10/min buckets are account-wide (spec A8). Cache is **per user** (isolation, REQ-13).

### 1.2 OAuth model (REQ-3/REQ-4/D1)

Our server is simultaneously the **MCP resource server** and an **OAuth authorization server** that *bridges* to Zendesk:

- claude.ai performs OAuth discovery + (likely) dynamic client registration against our `mcpAuthRouter`.
- `authorize` redirects the user to **Zendesk** (`buildAuthorizationUrl`, PKCE S256, state/CSRF from `oauth-flow.ts`).
- On the Zendesk callback we run `exchangeCodeForTokens`, **persist the Zendesk tokens server-side encrypted** keyed by a minted `identity`, and issue claude.ai an **opaque access token** bound to that identity.
- `verifyAccessToken(ourToken)` → `AuthInfo{ clientId, scopes, extra:{ identity } }`.

We do **not** hand Zendesk tokens to claude.ai (D1/REQ-8: tokens stay server-side, encrypted). This is a full `OAuthServerProvider`, not the pass-through `ProxyOAuthServerProvider` (kept as a reference/fallback only).

> **A3 is not fully known.** The exact claude.ai custom-connector handshake (which discovery documents it fetches, whether it requires RFC 7591 dynamic client registration, the redirect URIs it uses, PKCE requirement) can only be pinned by a **live Owner registration**. Task 0 is a verification spike that records the real contract before we build Tasks 6–8. Code below is written against the SDK's documented handshake with the spike-confirmed values isolated in `src/remote/connector-contract.ts` so a contract change is a one-file edit, never a rewrite.

---

## 2. File structure (additive unless marked EDIT)

```
src/
  server.ts                         # EDIT: add optional ServerDeps 2nd arg (stdio path unchanged)
  client/
    http-client.ts                  # EDIT: authManager typed as TokenProvider (behaviour identical)
    token-provider.ts               # NEW: TokenProvider interface (1 type)
  auth/
    identity-store.ts               # NEW: per-user encrypted Zendesk-token store (reuses TokenStore)
    identity-resolver.ts            # NEW: identity → cached per-user AuthManager (TokenProvider)
    issued-token-store.ts           # NEW: opaque-token ↔ identity map (our AS tokens), encrypted, TTL
  remote/
    connector-contract.ts           # NEW: spike-confirmed constants (redirect URIs, scopes, paths)
    bridge-oauth-provider.ts        # NEW: OAuthServerProvider bridging claude.ai ⇄ Zendesk
    zendesk-identity.ts             # NEW: fetch Zendesk /users/me → stable identity
    remote-server.ts                # NEW: buildRemoteApp(env, deps) → express app (no listen)
    session-manager.ts              # NEW: sessionId → { transport, server } lifecycle + per-user ctx
    audit-log.ts                    # NEW: append-only write-audit log, 90-day rotation
    logger.ts                       # NEW: secret/PII-redacting structured logger
  bin/
    remote.ts                       # NEW: entrypoint — buildRemoteApp(...).listen(PORT)
deploy/
  Dockerfile                        # NEW
  docker-compose.yml                # NEW: app + reverse proxy (TLS), EU region, restart:always
  zendesk-remote.service            # NEW: systemd alternative
  README.md                         # NEW: ops runbook (EU VM, secrets, TLS, retention)
scripts/
  spike-remote.mjs                  # NEW (throwaway): minimal remote MCP for the Task 0 spike
tests/
  server-remote/
    remote-init.test.ts             # REQ-1 init + malformed + oversized
    stdio-unchanged.test.ts         # REQ-1 regression (64 tools over stdio-built createServer)
    tool-parity.test.ts             # REQ-2 names + schemas + count=64
    kpi-read.test.ts                # REQ-5
    safe-write.test.ts              # REQ-6
    screening-remote.test.ts        # REQ-7
    isolation.test.ts               # REQ-13
    failure-messaging.test.ts       # REQ-12
    smoke.test.ts                   # REQ-11 in-process HTTP smoke
  auth/
    identity-store.test.ts          # REQ-4/REQ-8 keyed + isolated + fail-closed
    identity-resolver.test.ts       # REQ-4 caching + refresh-failure message
    bridge-oauth-provider.test.ts   # REQ-3/REQ-4 authorize/exchange/verify (injected fetch)
  remote/
    audit-log.test.ts               # REQ-10 shape + no PII/secret + rotation
    logger.test.ts                  # REQ-8 redaction (extends secret-safe guarantee)
package.json                        # EDIT: scripts (start:remote, test unchanged), bin entry
docs/superpowers/plans/2026-07-30-m9-remote-connector.md   # this file
```

---

## 3. Ordered task list (TDD, bite-sized)

Each task: **RED** (failing test) → **GREEN** (code) → **REFACTOR**. Numeric spine enforced: functions < 50 lines, files < 400 typical / 800 hard max, nesting ≤ 4. No `any`. Immutability. Errors surfaced at boundaries.

### Task 0 — VERIFICATION SPIKE: pin the claude.ai connector contract (BLOCKED on Owner) `[REQ-3, A3]`

**Goal:** confirm the *real* custom-connector OAuth/discovery/registration contract before building the full auth surface. This is deliberately first — a wrong assumption here rewrites Tasks 6–8.

**Deliverable:** `scripts/spike-remote.mjs` — a minimal remote MCP over Streamable HTTP with a single dummy tool and `mcpAuthRouter` wired to a throwaway provider that accepts one hardcoded dev identity. Deploy to the EU VM behind TLS, then the **Owner registers it as a claude.ai custom connector**. Record, in `src/remote/connector-contract.ts` (as real constants), the empirically confirmed:

- discovery document path(s) claude.ai fetches (e.g. `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`);
- whether **dynamic client registration** (`/register`) is required or a pre-registered `client_id` is used;
- the exact **redirect URI(s)** claude.ai calls back on (allow-list these);
- PKCE requirement (expect S256) and scope strings claude.ai sends;
- the header/format of the Bearer token claude.ai presents on MCP calls.

```js
// scripts/spike-remote.mjs — throwaway; deleted after the contract is recorded.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Log EVERY request line + headers (NO bodies) so the live registration reveals the contract.
app.use((req, _res, next) => { console.error(`[spike] ${req.method} ${req.url}`); next(); });

app.post('/mcp', async (req, res) => {
  const server = new McpServer({ name: 'zendesk-spike', version: '0.0.0' });
  server.tool('ping', 'spike probe', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(Number(process.env.PORT ?? 8080), () => console.error('[spike] up'));
```

**Acceptance:** the recorded contract is committed as `connector-contract.ts` constants; A3 is closed or its deltas are noted. **External unblock:** Owner performs the registration. Until then, Tasks 6–8 build against the SDK-documented defaults in `connector-contract.ts` and are re-verified after the spike.

**No production code** ships from this task beyond `connector-contract.ts` values.

---

### Task 1 — Narrow the http-client auth seam to `TokenProvider` `[REQ-4]`

**RED** — `tests/server-remote/…` (unit under `tests/client/`): a fake `TokenProvider` returning a fixed token drives `ZendeskHttpClient.request` (injected `fetchImpl`), asserting the `Authorization: Bearer <token>` header — proving the client depends only on `getAccessToken()`.

**GREEN**

`src/client/token-provider.ts`:

```ts
// The minimal auth dependency ZendeskHttpClient needs: hand it a valid bearer token.
// AuthManager already satisfies this; per-user resolution supplies a different impl per session.
export interface TokenProvider {
  getAccessToken(): Promise<string>;
}
```

`src/client/http-client.ts` — change only the option type (no logic change):

```ts
import type { TokenProvider } from './token-provider.js';
// ...
export interface ZendeskHttpClientOptions {
  subdomain: string;
  authManager: TokenProvider;   // was: AuthManager — AuthManager is a TokenProvider, so callers are unaffected
  rateLimiter: RateLimiter;
  incrementalRateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  maxRateLimitRetries?: number;
}
```

Delete the now-unused `import type { AuthManager }`. Every call site (`server.ts`) still passes an `AuthManager`, which is assignable. `tsc` stays green.

**REFACTOR:** none. **Verify:** full suite green (behaviour-preserving).

---

### Task 2 — Injectable `createServer(env, deps?)` (stdio path unchanged) `[REQ-1]`

**RED** — `tests/server-remote/stdio-unchanged.test.ts`: (a) `createServer(fixtureEnv)` with no deps still lists exactly 64 tools (regression); (b) `createServer(fixtureEnv, { authManager: fake, rateLimiter: shared, incrementalRateLimiter: shared, cache: custom })` uses the injected deps (assert the injected fake `getAccessToken` is what the wired client calls).

**GREEN** — `src/server.ts`, additive optional 2nd arg. Defaults reproduce today's behaviour exactly:

```ts
export interface ServerDeps {
  authManager?: TokenProvider;          // default: AuthManager over the single env token file (stdio)
  rateLimiter?: RateLimiter;            // default: new 400/min bucket
  incrementalRateLimiter?: RateLimiter; // default: new 10/min bucket
  cache?: ResponseCache;                // default: new ResponseCache(`${dataDir}/cache`)
}

export function createServer(env: NodeJS.ProcessEnv = process.env, deps: ServerDeps = {}): CreatedServer {
  const { config: oauthConfig, dataDir, tokensPath } = resolveAuthConfig(env);
  const { subdomain, clientSecret } = oauthConfig;
  const securityLevel = parseSecurityLevel(env.ZENDESK_SECURITY_LEVEL);
  const markdownDefault = parseMarkdownDefault(env.ZENDESK_MARKDOWN_CONVERSION);

  const authManager = deps.authManager
    ?? new AuthManager(new TokenStore(tokensPath, clientSecret), oauthConfig);
  const rateLimiter = deps.rateLimiter ?? new RateLimiter({ requestsPerMinute: DEFAULT_RATE_LIMIT_RPM });
  const incrementalRateLimiter = deps.incrementalRateLimiter ?? new RateLimiter({ requestsPerMinute: INCREMENTAL_RATE_LIMIT_RPM });
  const httpClient = new ZendeskHttpClient({ subdomain, authManager, rateLimiter, incrementalRateLimiter });
  const cache = deps.cache ?? new ResponseCache(`${dataDir}/cache`);

  const server = new McpServer({ name: 'zendesk', version: '0.1.0' });
  const ctx: ToolContext = { httpClient, cache, securityLevel, markdownDefault, reportConfig: parseReportConfig(env) };
  registerCoreTools(server, ctx);
  registerTicketTools(server, ctx);
  registerSearchTools(server, ctx);
  registerDirectoryTools(server, ctx);
  registerBusinessRulesTools(server, ctx);
  registerGuideTools(server, ctx);
  registerAnalyticsTools(server, ctx);
  return { server, ctx, rateLimiter, incrementalRateLimiter };
}
```

The stdio entrypoint guard is unchanged (`createServer()` with no deps). **Verify:** 64-tool regression + injection test green.

---

### Task 3 — Per-user encrypted token store + identity resolver `[REQ-4, REQ-8, REQ-13, D1, D3]`

**RED** — `tests/auth/identity-store.test.ts`: save tokens for identity A and B → two distinct files under `users/`; A cannot be read with B's key path; a tampered blob / rotated secret **fails closed** with the re-authorize message (reuses `AuthManager.loadFromStore` semantics). `tests/auth/identity-resolver.test.ts`: `forIdentity(id)` returns a cached `AuthManager` (same instance on repeat); refresh-failure surfaces the actionable message.

**GREEN**

`src/auth/identity-store.ts` — one encrypted file per identity, reusing `TokenStore` verbatim (AES-256-GCM). Filename = salted SHA-256 of the identity so a raw identity never lands on disk:

```ts
import { createHash } from 'node:crypto';
import { TokenStore } from './token-store.js';

// One AES-256-GCM file per connector identity under <dataDir>/users/. The identity is hashed
// (not stored raw) so the filesystem never carries a user identifier in cleartext.
export class IdentityTokenStore {
  constructor(private readonly usersDir: string, private readonly encryptionSecret: string) {}

  storeFor(identity: string): TokenStore {
    const file = `${this.usersDir}/${this.fileKey(identity)}.enc`;
    return new TokenStore(file, this.encryptionSecret);
  }

  private fileKey(identity: string): string {
    return createHash('sha256').update(`zendesk-user:${identity}`).digest('hex');
  }
}
```

`src/auth/identity-resolver.ts` — identity → cached per-user `AuthManager` (a `TokenProvider`):

```ts
import { AuthManager } from './auth-manager.js';
import { IdentityTokenStore } from './identity-store.js';
import type { OAuthConfig } from './oauth-flow.js';
import type { TokenProvider } from '../client/token-provider.js';

// Lazily builds and caches one AuthManager per identity, over that identity's own encrypted
// TokenStore. AuthManager already implements single-flight refresh + fail-closed load, so per-user
// isolation reuses all of it — the only new axis is "which file".
export class IdentityAuthResolver {
  private readonly cache = new Map<string, AuthManager>();
  constructor(private readonly stores: IdentityTokenStore, private readonly config: OAuthConfig) {}

  forIdentity(identity: string): TokenProvider {
    const existing = this.cache.get(identity);
    if (existing) return existing;
    const manager = new AuthManager(this.stores.storeFor(identity), this.config);
    this.cache.set(identity, manager);
    return manager;
  }

  // Called by the bridge provider right after a successful Zendesk code exchange.
  persist(identity: string, tokens: { accessToken: string; refreshToken: string; expiresAt: number }): void {
    this.stores.storeFor(identity).save(tokens);
    this.cache.delete(identity); // force a fresh AuthManager to pick up the new tokens
  }

  revoke(identity: string): void {
    this.stores.storeFor(identity).clear();
    this.cache.delete(identity);
  }
}
```

**Verify:** isolation + fail-closed + caching tests green.

---

### Task 4 — Tool-surface parity harness `[REQ-2]`

**RED/GREEN** — `tests/server-remote/tool-parity.test.ts`: build two servers from the same env — one via the stdio default `createServer(env)`, one via the remote injection path `createServer(env, { authManager: fake, rateLimiter, incrementalRateLimiter, cache })` — list tools from both `McpServer` instances, assert:

- identical **set of names**;
- each tool's **input JSON Schema is deep-equal** (serialize with a stable key sort, compare);
- **count === 64**.

Because both paths call the identical `register*` functions, this passes by construction and **fails loudly on any future drift** (REQ-2 negative). No production code — this is a contract test. List tools via the SDK client `listTools()` over an in-memory transport pair, or via the server's registered-tool registry if exposed.

---

### Task 5 — Secret/PII-redacting logger + write-audit log `[REQ-8, REQ-10, D3]`

**RED** — `tests/remote/logger.test.ts` (extends the M8 `secret-safe-logging` guarantee to the remote path): log lines carrying a bearer token, a client secret, and a ticket body are emitted with those values **redacted**; no raw token/secret/PII substring survives. `tests/remote/audit-log.test.ts`: a write records `{ ts, identityHash, tool, targetId, outcome }` with **no PII body and no secret**; entries older than 90 days are rotated out.

**GREEN**

`src/remote/logger.ts` — structured, redacting; no `console.log` (extends the M8 static guard to `src/remote/**`). Redacts `Authorization` values, anything token/secret-shaped, and never accepts free-text bodies:

```ts
const REDACT = /(bearer\s+[\w.\-]+)|([A-Za-z0-9_\-]{24,})/gi;

export interface LogFields { requestId?: string; tool?: string; outcome?: string; latencyMs?: number; msg: string; }

// Structured line to stderr with token/secret redaction. Bodies/PII are never passed in by
// contract — callers pass ids and outcomes, not ticket content.
export function log(fields: LogFields): void {
  const safe = { ...fields, msg: fields.msg.replace(REDACT, '[redacted]') };
  process.stderr.write(JSON.stringify(safe) + '\n');
}
```

`src/remote/audit-log.ts` — append-only JSONL, hashed identity, 90-day retention (D3/A7):

```ts
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface AuditEntry { ts: number; identityHash: string; tool: string; targetId: string; outcome: 'applied' | 'conflict' | 'error'; }

export class WriteAuditLog {
  constructor(private readonly filePath: string) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  record(identity: string, tool: string, targetId: string, outcome: AuditEntry['outcome']): void {
    const entry: AuditEntry = { ts: Date.now(), identityHash: this.hash(identity), tool, targetId, outcome };
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  // Called on a timer (and at startup): drop entries past the 90-day window.
  prune(now: number = Date.now()): void {
    if (!existsSync(this.filePath)) return;
    const kept = readFileSync(this.filePath, 'utf8')
      .split('\n').filter(Boolean)
      .filter((line) => now - (JSON.parse(line) as AuditEntry).ts <= RETENTION_MS);
    writeFileSync(this.filePath, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 });
  }

  private hash(identity: string): string {
    return createHash('sha256').update(`zendesk-user:${identity}`).digest('hex').slice(0, 16);
  }
}
```

> Audit hooks are invoked from the session layer's tool-result observer (Task 8), not by editing tool files — the write tools already return a `MutationResult` (`applied`/`conflict`); the session wrapper maps that to an audit record. Where the transport does not expose per-tool results generically, the audit call is placed in the per-session `server.server.setRequestHandler` wrap around `tools/call` in `session-manager.ts` (additive, no tool-file edit).

**Verify:** redaction + audit-shape + prune tests green.

---

### Task 6 — Zendesk-bridge OAuth provider `[REQ-3, REQ-4, D1]` (contract-gated by Task 0)

**RED** — `tests/auth/bridge-oauth-provider.test.ts` (injected `fetch`, no network):
- `authorize` issues a redirect to the **Zendesk** authorize URL with S256 `code_challenge` + `state` (reuse `buildAuthorizationUrl`).
- the callback → `exchangeAuthorizationCode` runs `exchangeCodeForTokens`, **persists** per-user Zendesk tokens via `IdentityAuthResolver.persist`, and mints an opaque access token bound to the identity.
- `verifyAccessToken(ourToken)` → `AuthInfo{ extra.identity }`; an unknown/expired opaque token throws → maps to 401 (REQ-3 negative: unauthenticated session).
- `state`/redirect mismatch is refused (reuse the CSRF discipline of `oauth-flow.ts`).

**GREEN** — `src/auth/issued-token-store.ts`: opaque-token ↔ identity map, encrypted at rest (reuse `TokenStore`'s cipher via a small keyed record file), TTL-bounded. `src/remote/zendesk-identity.ts`: `fetchZendeskIdentity(subdomain, accessToken, fetchImpl)` → GET `/api/v2/users/me.json`, returns a stable `user.id`-based identity (validated with a `zod` schema; malformed → throw, never `NaN`). `src/remote/bridge-oauth-provider.ts` implements `OAuthServerProvider`:

```ts
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { buildAuthorizationUrl, exchangeCodeForTokens, type OAuthConfig } from '../auth/oauth-flow.js';
import { fetchZendeskIdentity } from './zendesk-identity.js';
import { IdentityAuthResolver } from '../auth/identity-resolver.js';
import { IssuedTokenStore } from '../auth/issued-token-store.js';

// Bridges claude.ai (downstream) to Zendesk (upstream). claude.ai never receives Zendesk tokens:
// we persist those server-side (encrypted, per identity) and issue claude.ai an opaque token.
export class ZendeskBridgeOAuthProvider implements OAuthServerProvider {
  skipLocalPkceValidation = false;
  constructor(
    private readonly config: OAuthConfig,
    private readonly resolver: IdentityAuthResolver,
    private readonly issued: IssuedTokenStore,
    private readonly clients: import('@modelcontextprotocol/sdk/server/auth/clients.js').OAuthRegisteredClientsStore,
    private readonly deps: { pendingRedirect: (state: string, redirectUri: string, verifier: string) => void; fetchImpl?: typeof fetch } ,
  ) {}

  get clientsStore() { return this.clients; }

  async authorize(_client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const state = params.state ?? randomBytes(16).toString('hex');
    // Persist the downstream redirect + our own PKCE verifier keyed by state (single-use, TTL) so
    // the Zendesk callback can complete the exchange. Reuses oauth-flow's state/CSRF discipline.
    this.deps.pendingRedirect(state, params.redirectUri, params.codeChallenge);
    res.redirect(buildAuthorizationUrl(this.config, params.codeChallenge, state));
  }

  async challengeForAuthorizationCode(_c: OAuthClientInformationFull, code: string): Promise<string> {
    return this.issued.challengeFor(code);
  }

  async exchangeAuthorizationCode(_c: OAuthClientInformationFull, code: string, verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const tokens = await exchangeCodeForTokens(this.config, code, verifier ?? '', redirectUri ?? '', this.deps.fetchImpl);
    const identity = await fetchZendeskIdentity(this.config.subdomain, tokens.accessToken, this.deps.fetchImpl);
    this.resolver.persist(identity, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: Date.now() + tokens.expiresIn * 1000 });
    const opaque = this.issued.mint(identity); // encrypted opaque→identity, TTL-bounded
    return { access_token: opaque, token_type: 'Bearer', expires_in: 3600 };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    // Downstream (claude.ai) refresh re-mints an opaque token for the same identity; Zendesk-side
    // refresh is handled transparently by the per-user AuthManager.
    throw new Error('downstream refresh handled by session re-auth — see connector-contract.ts');
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const identity = this.issued.identityFor(token); // throws → 401 for unknown/expired
    return { token, clientId: 'claude.ai', scopes: this.config.scopes, extra: { identity } };
  }
}
```

> The precise wiring of `authorize` ↔ Zendesk callback ↔ `exchangeAuthorizationCode` (whether claude.ai drives the token endpoint directly or via our callback) is **contract-gated by Task 0**. `connector-contract.ts` holds the confirmed redirect/registration values; the provider logic above is stable regardless of that choice. Flagged assumption, isolated to one file.

**Verify:** provider unit tests green with injected fetch.

---

### Task 7 — Remote HTTP entrypoint reusing `createServer()` `[REQ-1, REQ-3, REQ-9]`

**RED** — `tests/server-remote/remote-init.test.ts`: an in-process MCP client initializes over the Streamable HTTP transport against `buildRemoteApp(fixtureEnv, deps)` and lists tools (count 64); a malformed/out-of-order frame → protocol error, process/other sessions survive; an oversized body / wrong content-type → 4xx, **no body logged**. `/health` returns healthy.

**GREEN** — `src/remote/remote-server.ts` builds the express app (no `listen`, so tests drive it in-process):

```ts
import express from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { resolveAuthConfig } from '../auth/config.js';
import { RateLimiter } from '../client/rate-limiter.js';
import { DEFAULT_RATE_LIMIT_RPM, INCREMENTAL_RATE_LIMIT_RPM } from '../server.js';
import { IdentityAuthResolver } from '../auth/identity-resolver.js';
import { IdentityTokenStore } from '../auth/identity-store.js';
import { IssuedTokenStore } from '../auth/issued-token-store.js';
import { ZendeskBridgeOAuthProvider } from './bridge-oauth-provider.js';
import { SessionManager } from './session-manager.js';
import { WriteAuditLog } from './audit-log.js';
import { CONNECTOR } from './connector-contract.js';
import { log } from './logger.js';

const BODY_LIMIT = '4mb';

export function buildRemoteApp(env: NodeJS.ProcessEnv = process.env) {
  const { config, dataDir } = resolveAuthConfig(env);
  const encryptionSecret = config.clientSecret; // server-held key; from secrets manager in prod
  const stores = new IdentityTokenStore(`${dataDir}/users`, encryptionSecret);
  const resolver = new IdentityAuthResolver(stores, config);
  const issued = new IssuedTokenStore(`${dataDir}/issued.enc`, encryptionSecret);
  const audit = new WriteAuditLog(`${dataDir}/audit/write-audit.jsonl`);

  // SHARED rate buckets across all sessions — the Zendesk 400/min + 10/min budget is account-wide.
  const rateLimiter = new RateLimiter({ requestsPerMinute: DEFAULT_RATE_LIMIT_RPM });
  const incrementalRateLimiter = new RateLimiter({ requestsPerMinute: INCREMENTAL_RATE_LIMIT_RPM });
  const sessions = new SessionManager(env, { resolver, rateLimiter, incrementalRateLimiter, dataDir, audit });

  const provider = new ZendeskBridgeOAuthProvider(config, resolver, issued, /* clientsStore */ CONNECTOR.clientsStore(), { pendingRedirect: issued.pendingRedirect.bind(issued) });

  const app = express();
  app.use(express.json({ limit: BODY_LIMIT }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(CONNECTOR.issuerUrl), scopesSupported: config.scopes, resourceServerUrl: new URL(CONNECTOR.resourceUrl) }));

  const bearer = requireBearerAuth({ verifier: provider });
  app.post('/mcp', bearer, (req, res) => sessions.handlePost(req, res).catch((e) => { log({ msg: `mcp post error: ${e.message}`, outcome: 'error' }); if (!res.headersSent) res.status(400).end(); }));
  app.get('/mcp', bearer, (req, res) => sessions.handleGet(req, res));
  app.delete('/mcp', bearer, (req, res) => sessions.handleDelete(req, res));
  return app;
}
```

`src/bin/remote.ts` (the `bin`/start script):

```ts
import { buildRemoteApp } from '../remote/remote-server.js';
const port = Number(process.env.PORT || 8080);
buildRemoteApp().listen(port, () => process.stderr.write(JSON.stringify({ msg: `remote MCP listening on ${port}` }) + '\n'));
```

`package.json`: add `"start:remote": "node dist/bin/remote.js"` and `"zendesk-remote": "dist/bin/remote.js"` under `bin`. **No new dependency** — `express`, `hono`/`@hono/node-server` are already present transitively via the SDK (verified).

**Verify:** remote-init + malformed + oversized + health tests green.

---

### Task 8 — Per-session isolation + audit wiring `[REQ-13, REQ-10]`

**RED** — `tests/server-remote/isolation.test.ts`: two concurrent authenticated sessions (identities U1, U2) → U1's tokens, cache handles, and per-session server are never observable to U2 (U2 cannot `zendesk_query` a handle minted in U1's cache). Writes append one audit entry each with the correct hashed identity.

**GREEN** — `src/remote/session-manager.ts`: maps `Mcp-Session-Id` → `{ transport, server }`; on `initialize`, reads `req.auth.extra.identity` (set by `requireBearerAuth`), builds a **per-user** `createServer(env, { authManager: resolver.forIdentity(identity), rateLimiter: SHARED, incrementalRateLimiter: SHARED, cache: new ResponseCache(`${dataDir}/cache/<identityHash>`) })`, connects a fresh `StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })`, and wraps `tools/call` to emit `audit.record(...)` on write results. Non-init requests without a known session → 400; unknown session id → 404 (SDK transport behaviour). Session close frees the entry.

Per-user cache dir = isolation by construction (the cache path already confines handles to its own dir — see `cache.ts` `resolveHandlePath`). Shared rate limiters keep the account-wide budget correct (A8).

**Verify:** isolation + audit tests green.

---

### Task 9 — KPI read path + safe write over the remote transport `[REQ-5, REQ-6]`

**RED/GREEN** — reuse-proving integration tests over the remote transport with a **mocked Zendesk client** (inject `fetchImpl` into the per-session http-client via a test seam on `SessionManager`):

- `tests/server-remote/kpi-read.test.ts` (REQ-5): call `zendesk_report`/`zendesk_search` → counts grouped by the funding-status custom field (Bewilligt/Abgelehnt/Sammelantrag QCG/EGZ…, treated as opaque German values); **no write tool invoked**; empty range → explicit zero (not error, not fabricated); a >1000-result query surfaces the cap (existing behaviour).
- `tests/server-remote/safe-write.test.ts` (REQ-6): `zendesk_update_ticket` with `custom_fields:[{id,value}]` → confirm-before-write contract holds; `safe_update` + `updated_stamp` attached; 409 → re-fetch → screened conflict result (no blind overwrite) via `safeUpdateWithConflict`; empty update rejected before PUT (`updateEntity` empty-guard); **no destructive tool exists** (assert by tool-inventory omission — reuses Task 4 list).

No production code beyond the `fetchImpl` test seam on `SessionManager` (already needed for tests). These pass because the tools are literally the same registrations — the tests prove parity of *behaviour*, not just surface.

---

### Task 10 — Screening carryover on the remote path `[REQ-7]`

**RED/GREEN** — `tests/server-remote/screening-remote.test.ts`: inbound ticket body containing `"ignore all previous instructions"` read via a remote tool → screened + wrapped in session-nonce delimiters, summary carries `SCREEN_WARNING` (reuse `security/screen.ts` + `screening.ts`); `ZENDESK_SECURITY_LEVEL` set on the deployment → per-session `ToolContext.securityLevel` equals it (default `standard`); ticket content **cannot** alter the level (only server env controls it — asserted by construction, `createServer` reads `env`, never request content). No production code — screening is inherited unchanged.

---

### Task 11 — GUI auth/session failure messaging `[REQ-12]`

**RED/GREEN** — `tests/server-remote/failure-messaging.test.ts`: a tool call before connector OAuth → 401 mapped to a clear "authorize the Zendesk connector" message; expired/revoked Zendesk token + failed refresh → the `AuthManager` re-authorize message surfaces (not a stack trace); an admin-gated write without the role → the existing `withAdminGuard` message surfaces. `src/remote/error-messages.ts` (small) maps auth errors → user-facing strings; reuses existing `AuthManager`/`withAdminGuard` copy verbatim (no new wording invented).

---

### Task 12 — Deploy: Dockerfile + run unit + health + rate-limit note `[REQ-9, REQ-10, A8]`

`deploy/Dockerfile` (multi-stage, Node 20 slim, non-root, EU VM):

```dockerfile
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/bin/remote.js"]
```

`deploy/docker-compose.yml`: the app + a TLS-terminating reverse proxy (Caddy/nginx), `restart: always`, EU-region host, secrets (`ZENDESK_OAUTH_CLIENT_SECRET`, encryption key, subdomain) injected from the host secrets manager — **never baked into the image**. A persistent named volume mounts `dataDir` (`users/*.enc`, `issued.enc`, `audit/`, `cache/`) so tokens survive restarts (REQ-9). `deploy/zendesk-remote.service` provides a systemd alternative. `deploy/README.md` documents the EU-VM runbook, TLS, secrets provisioning, and the **90-day retention** (audit prune timer + token "until revoke").

**Rate-limit note (A8, in `deploy/README.md`):** the Zendesk 400/min + 10/min buckets are **account-wide** and shared across all connector users (shared `RateLimiter` singletons). Under many concurrent GUI users this can 429. Mitigation documented: the client already self-heals on 429 via `Retry-After`; per-identity fairness is a P2 follow-up (would require per-identity sub-buckets under the account cap). Monitor 429 rate; if it becomes a problem, add a weighted fair-queue in front of the shared limiter — no tool change required.

No unit test for the container itself; a health-endpoint unit test lives in Task 7, and reachability/restart-persistence is a **manual** verification against the live EU VM.

---

### Task 13 — Remote release gate `[REQ-11]`

**Gate (all must pass):**

1. `npm run build` — clean `tsc --strict` (already `"strict": true`).
2. `npm test` — full vitest suite green (M0–M8 + all new `tests/server-remote/**`, `tests/auth/**`, `tests/remote/**`).
3. `tests/server-remote/smoke.test.ts` — in-process MCP client initializes over the HTTP transport and lists/calls a tool against a mocked Zendesk client (no live network).
4. Repo-wide grep proving no live code path silently reuses a single process-global `TokenStore` when per-user auth is active:
   ```bash
   ! grep -rnE "new TokenStore\(" src --include=*.ts | grep -v "identity-store.ts"
   ```
   (Only `IdentityTokenStore` may construct `TokenStore`; the stdio default in `server.ts` is the single-identity path and is explicitly allowed — the grep is scoped to catch a *remote* path regressing to a global store.)
5. `connector-contract.ts` reflects the Task 0 spike result (or its defaults are flagged as un-verified in the PR description).

**External unblocks** (cannot be closed inside the repo): Owner registers the connector in claude.ai (Task 0 + REQ-3 manual); ops provisions the EU VM + TLS + secrets (Task 12 + REQ-8/REQ-9 manual residency/TLS check).

---

## 4. Task count & sequencing

**14 tasks (0–13).** Dependency order:

```
0 SPIKE (Owner) ─┐                          (records contract; unblocks 6–8)
1 seam ──────────┼─▶ 2 createServer deps ─▶ 4 parity
                 │                           │
3 per-user store ┴─▶ 6 bridge provider ─────┼─▶ 7 remote entrypoint ─▶ 8 isolation+audit
5 logger+audit ──────────────────────────────┘                          │
                                                    9 KPI+write ─ 10 screening ─ 11 msg ─┘
                                                    12 deploy ── 13 gate (last)
```

- **Start immediately (no external blocker):** 1, 2, 3, 4, 5 (pure reuse/refactor + per-user store + parity + logging).
- **Blocked on Task 0 / Owner:** 6, 7, 8 build against `connector-contract.ts` defaults now and are **re-verified** after the live registration.
- **Blocked on ops (EU VM/TLS/secrets):** 12's manual reachability/residency checks and 13's live smoke.

---

## 5. How per-user auth generalizes the single-identity seam

Today: `createServer` builds **one** `AuthManager` over **one** `TokenStore` file (`<dataDir>/tokens.enc`) and passes it into **one** `ZendeskHttpClient`. Every request uses that single identity.

The generalization is deliberately tiny and touches two seam files only:

1. **`http-client.ts`** — depend on `TokenProvider` (`{ getAccessToken(): Promise<string> }`) instead of the concrete `AuthManager`. `AuthManager` already satisfies it, so no call site changes and stdio behaviour is byte-identical.
2. **`server.ts`** — `createServer(env, deps?)` accepts an optional injected `authManager` (+ shared rate limiters + per-user cache). Default (stdio) reproduces today's construction exactly.

Per user, `IdentityAuthResolver.forIdentity(identity)` returns an `AuthManager` over `<dataDir>/users/<sha256(identity)>.enc` — the **same** `TokenStore` (AES-256-GCM), the **same** `AuthManager` (single-flight refresh, fail-closed load), just a different file. The remote session layer resolves identity from the verified Bearer token (`AuthInfo.extra.identity`) and injects that per-user provider into `createServer`. Rate buckets stay shared singletons (account-wide budget); cache is per-user (isolation). The 64 tools never learn any of this — they still receive a `ToolContext` with an `httpClient`.

---

## 6. The claude.ai-connector verification spike (Task 0)

**Why it's first:** the exact custom-connector OAuth/discovery/registration contract (discovery doc paths, dynamic-client-registration requirement, redirect URIs, PKCE, Bearer format) is **not documented to us** and can only be confirmed by a live Owner registration. Guessing it wrong would force a rewrite of Tasks 6–8.

**What it does:** ship a throwaway minimal remote MCP (`scripts/spike-remote.mjs`) to the EU VM behind TLS, have the **Owner register it as a claude.ai custom connector**, and record the observed contract as real constants in `src/remote/connector-contract.ts`. Every downstream task imports those constants, so a contract surprise is a one-file edit, not a redesign. This is the single explicit external unblock gating the auth surface.

---

## 7. Tasks blocked on external unblocks

| Unblock | Owner | Blocks |
|---|---|---|
| Register connector in claude.ai, record OAuth/discovery/DCR/redirect contract | **Claude-for-Teams Owner** (not the requester) | Task 0 → re-verification of Tasks 6, 7, 8; REQ-3 manual AC |
| Provision EU VM + TLS reverse proxy + secrets manager (client secret, encryption key) | **Ops** | Task 12 manual reachability/residency/TLS; Task 13 live smoke; REQ-8/REQ-9 manual ACs |
| Provide funding-status custom field id(s) + allowed values (Bewilligt/Abgelehnt/Sammelantrag QCG/EGZ…) | **Zendesk admin** | Task 9 fixtures realism (write path is field-agnostic; only test data needs the real id) |

All code tasks (1–11, 13's automated gate) proceed **without** these; they only need the defaults in `connector-contract.ts` and mocked Zendesk fixtures.

---

## 8. Self-review

### 8.1 REQ coverage matrix

| REQ | Task(s) | Notes |
|---|---|---|
| REQ-1 remote HTTP/SSE entrypoint reusing `createServer()` | 2, 7 | Streamable HTTP via SDK; stdio guard untouched; malformed/oversized negatives covered |
| REQ-2 tool-surface parity | 4 | names + JSON Schema deep-equal + count=64; drift fails build |
| REQ-3 claude.ai connector OAuth/discovery | 0, 6, 7 | `mcpAuthRouter` + bridge provider; **Task 0 spike pins the real contract** |
| REQ-4 per-user identity model | 1, 2, 3, 6 | `TokenProvider` seam + `IdentityAuthResolver` + per-user encrypted store |
| REQ-5 KPI read-only | 9 | grouping by funding custom field, empty/zero, 1000-cap, no write tool |
| REQ-6 safe write | 9 | confirm-before-write, `safe_update`, 409→conflict, empty-guard, no destructive |
| REQ-7 screening remote | 10 | reuse `screen.ts`/`screening.ts`; level from env only |
| REQ-8 PII/secret | 3, 5, 12 | redacting logger, AES-256-GCM per-user tokens, EU/TLS, fail-closed |
| REQ-9 always-on deploy | 7, 12 | `/health`, Dockerfile + compose/systemd, restart persistence via volume |
| REQ-10 least-privilege + write audit | 5, 8, 12 | audit log (no PII/secret), scope config, 90-day prune |
| REQ-11 release gate | 13 | build + suite + `--strict` + smoke + no-global-store grep |
| REQ-12 auth/session failure UX | 11 | reuse `AuthManager`/`withAdminGuard` messages |
| REQ-13 per-user session isolation | 8 | per-user server + cache dir; shared rate bucket only |

All 13 REQs mapped. D1/D2/D3 each realized (Tasks 3/6, 12, 3+5+12).

### 8.2 Placeholder scan

- No `TODO`/`FIXME`/`...`/`throw new Error('not implemented')` in shipped code. The one `throw` in `exchangeRefreshToken` is an intentional, documented behaviour (downstream refresh re-mints via session re-auth), not a stub.
- `connector-contract.ts` holds **concrete default constants** (SDK-documented paths/redirects), not blanks; Task 0 confirms/adjusts them. This is a flagged assumption with a working default, not a placeholder — code compiles and runs either way.
- `scripts/spike-remote.mjs` is intentionally throwaway (Task 0), clearly scoped and deleted after the contract is recorded.

### 8.3 Type-consistency vs real signatures

- `createServer(env, deps?)` extends the real signature `createServer(env = process.env)` additively; `CreatedServer` return type unchanged.
- `TokenProvider` = `{ getAccessToken(): Promise<string> }` — structurally implemented by the real `AuthManager.getAccessToken(): Promise<string>`. `ZendeskHttpClientOptions.authManager` retyped from `AuthManager` to `TokenProvider`; all existing constructions pass an `AuthManager` (assignable) → `tsc --strict` green.
- `IdentityTokenStore.storeFor` returns the real `TokenStore(filePath, encryptionSecret)`; `TokenStore.save` takes `{ accessToken, refreshToken, expiresAt }` = `StoredTokens` (matches `IdentityAuthResolver.persist`).
- Bridge provider implements the real `OAuthServerProvider` interface (from `server/auth/provider.js`): `clientsStore`, `authorize`, `challengeForAuthorizationCode`, `exchangeAuthorizationCode`, `exchangeRefreshToken`, `verifyAccessToken` — signatures match the SDK `.d.ts` inspected. `AuthInfo` shape (`token`, `clientId`, `scopes`, `extra`) matches `server/auth/types.d.ts`.
- `mcpAuthRouter({ provider, issuerUrl, scopesSupported, resourceServerUrl })` and `requireBearerAuth({ verifier })` match the SDK router/middleware types.
- `StreamableHTTPServerTransport({ sessionIdGenerator })` + `transport.handleRequest(req, res, req.body)` match the SDK Node transport (backed by `@hono/node-server`, present transitively — **verified in `node_modules`**).
- Reused write helpers (`safeUpdateWithConflict`, `updateEntity`, `withAdminGuard`) and screening (`makeScreener`, `screenRecordDeep`, `SCREEN_WARNING`) are consumed via their existing signatures — no tool file edited.

### 8.4 Ponytail check

- **Zero new runtime dependencies** — `express`, `hono`, `@hono/node-server` already resolve via the SDK; verified, not assumed.
- The behavioural change is **two seam edits** (`http-client.ts` type, `server.ts` optional arg); everything else is additive.
- OAuth AS endpoints, Bearer middleware, and the HTTP transport are **taken from the SDK**, not reimplemented. Only the Zendesk-specific bridge (which the SDK cannot provide) is new.
- Per-user storage reuses `TokenStore` (AES-256-GCM) unchanged — no new crypto.

---

## 9. Residual open questions

1. **claude.ai downstream token refresh** (`exchangeRefreshToken`): whether claude.ai expects a working refresh grant or re-runs authorize on expiry — **pinned by Task 0**. Current design re-mints on session re-auth; adjust in `connector-contract.ts`/provider if the spike shows claude.ai requires a refresh grant.
2. **Dynamic client registration**: whether claude.ai requires RFC 7591 `/register` or a pre-shared `client_id` — Task 0. `mcpAuthRouter` supports both; `CONNECTOR.clientsStore()` selects the mode.
3. **Per-identity rate fairness** (A8): shared account bucket may 429 under concurrency. Deferred to P2 with a documented mitigation path; flag if live load shows 429 storms.
4. **Funding custom field id(s)/values** (A4): needed only for realistic Task 9 fixtures; the write path is field-agnostic.
</content>
</invoke>
