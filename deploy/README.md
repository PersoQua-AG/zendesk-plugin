# Remote Zendesk MCP Connector — Ops Runbook (M9)

> **Status: ops-gated. Nothing here is deployed from this repo.** Deploying requires an EU VM,
> TLS, and provisioned secrets (see below). The artifacts in `deploy/` are ready; standing up the
> host, DNS, certificate, and secrets is an ops task.

## What this is

An always-on remote MCP server (`dist/bin/remote.js`, built from `src/bin/remote.ts`) that reuses
the exact 64-tool stdio surface over Streamable HTTP so claude.ai can register it as a custom
connector. The stdio Claude Code plugin is unchanged and continues to ship.

## Hard requirements (D2/D3, REQ-8/REQ-9)

- **EU region only.** VM, persistent volume, and all processing/storage stay in the EU (GDPR;
  applicant PII).
- **Public HTTPS, TLS >= 1.2**, stable hostname reachable from claude.ai's network. TLS terminates
  at the reverse proxy (Caddy in `docker-compose.yml`, or nginx/Caddy in front of the systemd unit).
- **Secrets from a secrets manager, never in the image or repo:** `ZENDESK_OAUTH_CLIENT_SECRET`,
  `ZENDESK_OAUTH_CLIENT_ID`, `ZENDESK_SUBDOMAIN`, `REMOTE_PUBLIC_URL` (the public https base URL),
  and `REMOTE_TOKEN_ENC_KEY`.
- **`REMOTE_TOKEN_ENC_KEY` is the data-encryption key** for the per-user (`users/*.enc`) and issued
  (`issued/*.enc`) token stores — REQUIRED, fail-closed if absent. It is DISTINCT from
  `ZENDESK_OAUTH_CLIENT_SECRET` and rotated independently: rotating the OAuth client secret must not
  brick the encrypted token files, and the OAuth secret must never double as the decrypt-all key.
  Boot is **fail-closed on a weak key**: it must carry >=32 bytes of entropy. Generate one with:
  `openssl rand -base64 32`.
- **Persistent `CLAUDE_PLUGIN_DATA` volume** so `users/*.enc` (per-user Zendesk tokens),
  `issued/*.enc`, `audit/write-audit.jsonl`, and `cache/` survive restarts (REQ-9). No re-auth
  storm on deploy.

## Deploy (docker compose)

```
# set the secrets in the environment / secrets manager first (do NOT commit them)
docker compose -f deploy/docker-compose.yml up -d --build
```

Provide a `deploy/Caddyfile` on the host that reverse-proxies `443 -> connector:8080` and obtains a
certificate for the public hostname. Health: the container `HEALTHCHECK` polls `/health`.

## Deploy (systemd alternative)

Install the built app to `/opt/zendesk-connector`, put secrets in
`/etc/zendesk-connector/connector.env` (mode 0600), then `systemctl enable --now zendesk-remote`.
Front it with nginx/Caddy for TLS.

**`ReadWritePaths` must contain `CLAUDE_PLUGIN_DATA` (L5).** The unit runs `ProtectSystem=strict`,
so the process may only write to paths listed in `ReadWritePaths`. Set `CLAUDE_PLUGIN_DATA` to a
directory under that path (the unit ships `/var/lib/zendesk-connector`); otherwise token writes fail
with `EROFS`. If you move the data dir, update `ReadWritePaths` to match.

## Retention (D3/A7)

- **Write-audit log:** 90-day retention, enforced IN-PROCESS. The server prunes on startup and on an
  unref'd daily timer — no cron job or manual command required. A torn JSONL line (crash mid-append)
  is skipped, not fatal.
- **Per-user tokens:** kept until the user revokes/re-authorizes. GDPR erasure = delete that
  identity's `users/<hash>.enc` (`IdentityAuthResolver.revoke`).

## Rate limiting & abuse controls (H1)

The unauthenticated OAuth/DCR surface (`/register`, `/authorize`, `/token`, `/callback`) and `/mcp`
sit behind a per-IP HTTP rate limiter (`express-rate-limit`, resolved transitively via the MCP SDK —
no new direct dependency). The JSON body limit is 256kb (JSON-RPC/OAuth payloads are small). The
in-memory pending-authorize map and the DCR clients store are both hard-capped. `/callback` only
302s to an https host on the allowlist (`REMOTE_ALLOWED_REDIRECT_HOSTS`, default `claude.ai`).

## Security follow-ups before broad / untrusted onboarding

- **M2 — per-identity fair-share rate limiter (DEFERRED).** The account-wide Zendesk budget is shared
  across all connector users; a single authenticated tenant can still exhaust it. For the internal
  pilot (few trusted users) the compensating control is trusted users + 429 monitoring + the H1
  per-IP HTTP limiter. Add a weighted fair-queue (per-identity sub-buckets under the account cap,
  no tool change) **before onboarding untrusted or many tenants.**
- **L2 (per-identity cache-map bound), L3 (downstream scope narrowing), L4 (audit `targetId` stored
  cleartext — by design, it is not PII) — accepted as-is** for the pilot.

## Rate limits (A8)

The Zendesk `400/min` and `10/min` (incremental) buckets are **account-wide** and shared across all
connector users (shared `RateLimiter` singletons). Under many concurrent GUI users this can 429.

- The client already self-heals on 429 via `Retry-After`, so transient bursts recover automatically.
- **Monitor the 429 rate.** If 429s become frequent, add a weighted fair-queue in front of the
  shared limiter (per-identity sub-buckets under the account cap) — a P2 follow-up that needs **no
  tool change**.

## Connector registration (REQ-3, Owner-gated)

The exact claude.ai custom-connector OAuth/discovery/registration contract is pinned by a live
Owner registration (Task 0, `scripts/spike-remote.mjs`); the confirmed values live in
`src/remote/connector-contract.ts`. Until then the connector runs against the SDK-documented
defaults marked `ASSUMED` there.
