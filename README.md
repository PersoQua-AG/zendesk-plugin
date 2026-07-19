# Zendesk Plugin

Claude Code plugin managing all Zendesk data, tickets, and operations —
Support/Tickets, Users & Organizations, Business Rules, Help Center/Guide,
Data Analytics, plus a Microsoft 365 bridge (Outlook/Teams/Calendar/SharePoint).

## Status

Research (Phase 1) and requirements (Phase 2) complete. Foundation implementation
(M0+M1: OAuth, core infra) planned, not yet built.

## Documents

- [PRD](docs/superpowers/specs/2026-07-09-zendesk-plugin-prd.md) — full requirements, API research, prior-art analysis
- [Foundation implementation plan](docs/superpowers/plans/2026-07-09-zendesk-plugin-foundation.md) — 17-task TDD plan for M0+M1
- [Handover](docs/superpowers/handover-zendesk-plugin-foundation.md) — paste-ready orchestrator prompt to execute the plan via subagent-driven-development

## Scope

Full read/write, no destructive operations (no delete/merge/redact). OAuth 2.0
(authorization-code + PKCE). TypeScript. See the PRD for full details.
