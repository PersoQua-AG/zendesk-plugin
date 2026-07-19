# Project Handover — Zendesk Claude Code Plugin

**Date:** 2026-07-15
**Owner:** r.pfisterer@persoqua.de
**Repo:** [PersoQua-AG/zendesk-plugin](https://github.com/PersoQua-AG/zendesk-plugin) (private)
**Local path:** `/Users/pfist/Developer/Otterstedt/persoqua/Claude Plugins/Zendesk Plugin`

Read this first if picking up the project cold — it links to every other document and states what's decided vs. still open.

---

## 1. What this is

A Claude Code plugin (TypeScript) that manages **all** Zendesk data, tickets, and operations from inside Claude: Support/Tickets, Users & Organizations, Business Rules (views/macros/triggers/automations/SLAs), Help Center/Guide, and Data Analytics — plus a Microsoft 365 bridge (Outlook/Teams/Calendar/SharePoint) in place of Slack. No official Zendesk MCP server exists; existing community servers only cover slices. This project builds broad + deep coverage in one plugin.

## 2. Where things stand (phase status)

| Phase | Status |
|---|---|
| 1 — Research (Zendesk API surface, prior art) | ✅ Done |
| 2 — Requirements engineering + check-in | ✅ Done, approved 2026-07-14 |
| 3a — Implementation plan (Plan 1: Foundation, M0+M1) | ✅ Written, self-reviewed |
| 3b — Execute Plan 1 | ⏳ Not started — see §5 |
| 3c — Plans 2–N (tool modules M2–M6, Claude-layer M7, packaging M8) | ⏳ Not written yet — depends on Plan 1 landing and being reviewed |

**Nothing has been built yet.** `zendesk-plugin/` source code does not exist on disk anywhere. This repo currently holds only planning documents.

## 3. Document map

| Document | Purpose |
|---|---|
| [`docs/superpowers/specs/2026-07-09-zendesk-plugin-prd.md`](docs/superpowers/specs/2026-07-09-zendesk-plugin-prd.md) | The PRD. Full requirements, Zendesk API research (auth, tickets, users/orgs, search, business rules, Guide, pagination, rate limits, incremental export, webhooks), reverse-engineered prior art, and all confirmed scope decisions. **Source of truth — do not re-litigate decisions already made here.** |
| [`docs/superpowers/plans/2026-07-09-zendesk-plugin-foundation.md`](docs/superpowers/plans/2026-07-09-zendesk-plugin-foundation.md) | Implementation plan for **Plan 1: Foundation (PRD milestones M0+M1)** — 17 bite-sized TDD tasks: project scaffold, OAuth 2.0 PKCE, and core infra (rate limiter, cursor paginator, async job poller, response cache, query engine, error mapping, injection-security screening). Ends with one working tool, `zendesk_get_me`. Complete, runnable code in every step — no placeholders. |
| [`docs/superpowers/handover-zendesk-plugin-foundation.md`](docs/superpowers/handover-zendesk-plugin-foundation.md) | **Execution handover** — a paste-ready prompt for a fresh Claude Code session to run Plan 1 via `superpowers:subagent-driven-development` (main thread orchestrates, fresh implementer subagent per task, two-stage spec+quality review, continuous execution). Use this to actually build the foundation. |
| `README.md` | Short public-facing summary. |
| This file | Project-level orientation — start here. |

## 4. Key decisions (locked — see PRD §4/§12 for full rationale)

- **Scope:** Full read/write, **no destructive operations** (no delete, merge, redact — anywhere, ever, by design/omission).
- **API coverage:** Support/Tickets, Users & Orgs, Business Rules, Help Center/Guide, Data Analytics (metrics + incremental export). Talk/Chat/Sunshine Conversations and Sell explicitly out of scope.
- **Auth:** OAuth 2.0, authorization-code + PKCE. API-token is an optional documented fallback, not the default.
- **Zendesk plan tier:** Professional (400 req/min; SLAs available; ticket forms & custom roles are Enterprise-gated → read-only/degrade gracefully).
- **Testing:** Mocks/fixtures first. Every module takes injected `fetch`/dependencies — no test touches a real Zendesk account. Live integration testing is deferred, not required to ship Plan 1.
- **Distribution:** Public release is the eventual goal (OSS license, hardened validation, `marketplace.json`) — but that's packaging (M8), not now.
- **Microsoft 365 bridge:** replaces the originally-considered Slack integration. Composes with the Microsoft 365 MCP (Outlook/Teams/Calendar/SharePoint) rather than adding new Zendesk endpoints.
- **Required Claude-layer skills:** `ticket-manager` (full lifecycle, safe_update optimistic concurrency) and `data-analyst` (volume/SLA/FRT/CSAT reporting) — both mandatory per explicit user request, spec'd in PRD §6/§7.

## 5. Next step — build the foundation

Open a fresh Claude Code session **in this repo** (`/Users/pfist/Developer/Otterstedt/persoqua/Claude Plugins/Zendesk Plugin`) and paste the full contents of [`docs/superpowers/handover-zendesk-plugin-foundation.md`](docs/superpowers/handover-zendesk-plugin-foundation.md) (the fenced prompt block) as the first message. It will:
1. Read the PRD and Plan 1 in full.
2. Set up an isolated git worktree.
3. Execute all 17 tasks via `superpowers:subagent-driven-development` (implementer → spec review → quality review per task), continuously, without stopping to check in.
4. Stop only on: all tasks done, an unresolvable blocker, or a genuine ambiguity the plan doesn't cover.
5. Present merge/PR/cleanup options at the end via `superpowers:finishing-a-development-branch` — it will not push, merge, or force anything without your explicit go-ahead.

After Plan 1 lands and is reviewed, the next planning session should write **Plan 2** (tool modules for Support/Tickets, Users/Orgs — PRD milestones M2–M3) using `superpowers:writing-plans`, following the same self-contained, no-placeholder discipline as Plan 1.

## 6. Open items / things a fresh session should know

- **No OAuth client is registered yet.** Real Zendesk connection setup (registering an OAuth client in Zendesk Admin Center, redirect URI `http://localhost:8976/callback`) is a documented step in the PRD (§5.1) and README stub (Plan 1, Task 17) — not needed until someone wants to test against a live account. Plan 1's tests never require it.
- **"Otterstedt" vs. "PersoQua-AG":** the user refers to the company as Otterstedt; the actual GitHub org is `PersoQua-AG`. This repo was created there per explicit confirmation on 2026-07-15.
- **Stale copies exist** in `/Users/pfist/Shopify AI/docs/superpowers/` (a local-only scratch repo with no remote, used during brainstorming before this repo existed). Not yet cleaned up — pending user confirmation to delete. Do not treat that location as a source of truth; this repo is authoritative.
- **Prior art considered and reverse-engineered** (see PRD §13 for details): [andmarios/zendesk-skill](https://github.com/andmarios/zendesk-skill) (save-first/query-later cache, injection-security pipeline, Markdown↔HTML), [davepoon/zendesk-automation](https://github.com/davepoon/buildwithclaude/tree/main/plugins/all-skills/skills/zendesk-automation) (safe_update optimistic concurrency, lifecycle-state model), [fruggr/zendesk-mcp-server](https://github.com/fruggr/zendesk-mcp-server) (OAuth PKCE, TS reference), [mattcoatsworth/zendesk-mcp-server](https://github.com/mattcoatsworth/zendesk-mcp-server) (broadest tool inventory).

## 7. Contact

r.pfisterer@persoqua.de — approves scope changes, phase check-ins, and any destructive/irreversible action.
