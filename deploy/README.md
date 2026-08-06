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
- **Secrets from a secrets manager, never in the image or repo:** `ZENDESK_OAUTH_CLIENT_SECRET`
  (also the server-held encryption key for the token stores), `ZENDESK_OAUTH_CLIENT_ID`,
  `ZENDESK_SUBDOMAIN`, and `REMOTE_PUBLIC_URL` (the public https base URL).
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

## Retention (D3/A7)

- **Write-audit log:** 90-day retention. `WriteAuditLog.prune()` drops older entries; run it at
  startup and on a daily timer (cron/systemd timer calling a small prune invocation).
- **Per-user tokens:** kept until the user revokes/re-authorizes. GDPR erasure = delete that
  identity's `users/<hash>.enc` (`IdentityAuthResolver.revoke`).

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
