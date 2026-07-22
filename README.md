# Zendesk Plugin

Claude Code plugin managing all Zendesk data, tickets, and operations —
Support/Tickets, Users & Organizations, Business Rules, Help Center/Guide,
Data Analytics, plus a Microsoft 365 bridge (Outlook/Teams/Calendar/SharePoint).

## Status

Foundation (M0+M1: OAuth 2.0 PKCE auth + core infrastructure — rate limiter,
cursor paginator, async job poller, response cache, query engine, error mapping,
injection screening, raw-REST client) implemented, with one working end-to-end
tool: `zendesk_get_me`. Tool coverage for tickets, users, business rules, Guide,
and analytics lands in follow-up milestones — see the PRD.

## Setup

1. In Zendesk Admin Center, go to **Apps and integrations → APIs → Zendesk API → OAuth Clients**
   and register a new client. Set the redirect URI to `http://localhost:8976/callback`
   (or your chosen `oauth_callback_port`).
2. Install this plugin in Claude Code and provide, when prompted:
   - `zendesk_subdomain` — the part before `.zendesk.com` in your Zendesk URL
   - `oauth_client_id` and `oauth_client_secret` — from step 1
3. Run the OAuth setup flow (see follow-up milestone) to authorize the plugin.
4. Ask Claude: "Who am I in Zendesk?" — this calls `zendesk_get_me` to confirm the
   connection works.

## Development

```bash
npm install
npm test        # run the test suite
npm run build
```

## Documents

- [PRD](docs/superpowers/specs/2026-07-09-zendesk-plugin-prd.md) — full requirements, API research, prior-art analysis
- [Foundation implementation plan](docs/superpowers/plans/2026-07-09-zendesk-plugin-foundation.md) — 17-task TDD plan for M0+M1
- [Handover](docs/superpowers/handover-zendesk-plugin-foundation.md) — paste-ready orchestrator prompt to execute the plan via subagent-driven-development

## Scope

Full read/write, no destructive operations (no delete/merge/redact). OAuth 2.0
(authorization-code + PKCE). TypeScript. See the PRD for full details.
