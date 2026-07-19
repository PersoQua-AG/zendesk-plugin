# Handover — Zendesk Plugin, Foundation Build (M0+M1)

**Date:** 2026-07-14
**Repo:** `/Users/pfist/Shopify AI` (git initialized locally, no remote configured)
**Current HEAD:** `fba5a9d` — "Add Zendesk plugin foundation implementation plan (M0+M1)"

## Why this document exists

This is a paste-ready handover so a **fresh Claude Code session** (this one, a new one, or another machine with the same repo) can pick up execution with zero re-explanation. It is not a GitHub-issue/PR pipeline handover — this repo has no remote and no custom `.claude/agents` cast, so that pipeline shape doesn't apply here. The actual mechanism is `superpowers:subagent-driven-development`: the main thread stays in control and dispatches a fresh implementer subagent per task, followed by a two-stage review (spec compliance, then code quality), continuously, without stopping to check in.

## State of the work

| Artifact | Path | Status |
|---|---|---|
| PRD | `docs/superpowers/specs/2026-07-09-zendesk-plugin-prd.md` | Approved (2026-07-14 check-in) |
| Implementation plan (this handover targets) | `docs/superpowers/plans/2026-07-09-zendesk-plugin-foundation.md` | Written, self-reviewed, **not yet executed** |
| Code | — | Nothing built yet — `zendesk-plugin/` does not exist on disk |

The plan covers **Plan 1 of N**: PRD milestones M0 (skeleton + OAuth) and M1 (core infra) only — 17 bite-sized TDD tasks ending in one working tool, `zendesk_get_me`. Tool modules (M2–M6), the Claude-layer skills/commands/subagent (M7), and packaging (M8) are separate plans to be written after this one lands and is reviewed.

Key decisions already locked (do not re-litigate — see PRD §4/§12 for the "why"):
- Full read/write, **no destructive operations** (no delete/merge/redact anywhere, ever)
- OAuth 2.0 authorization-code + PKCE
- Zendesk plan tier: Professional (400 req/min; ticket forms/custom roles are Enterprise-gated, read-only)
- **Mocks/fixtures first** — no live Zendesk account needed for this plan; `fetch`/dependencies are injected in every test
- Public-release bar for docs/security once packaging (M8) starts — not relevant yet for this plan

---

## The Orchestrator Prompt

Paste everything in the fenced block below as the **first message** of a fresh session in this repo.

````
I'm resuming work on the Zendesk Claude Code plugin. You are the main-thread orchestrator for this task — you do NOT write code yourself. You dispatch fresh subagents per task and review their work.

Context (read these two files first, in full):
1. docs/superpowers/specs/2026-07-09-zendesk-plugin-prd.md — the approved PRD. Do not re-litigate decisions already made in it.
2. docs/superpowers/plans/2026-07-09-zendesk-plugin-foundation.md — the implementation plan you are about to execute. It has 17 tasks, each with complete code, test-first steps, and exact commands. No placeholders — if you think something is missing, re-read the task, it's there.

Execution mechanism: use the superpowers:subagent-driven-development skill. Invoke it now via the Skill tool before doing anything else, and follow it exactly:
- Read the plan file ONCE yourself, extract all 17 tasks with their full text (code blocks included).
- Create a TodoWrite entry per task.
- First, use superpowers:using-git-worktrees to set up an isolated workspace. Consent is pre-granted — do not ask the user, just do it. Prefer a native worktree tool (e.g. EnterWorktree) if available; branch name: feature/zendesk-plugin-foundation.
- Per task: dispatch an implementer subagent with the task's full text + enough surrounding context (it must never read the plan file itself — you paste the content in). Let it implement, test, self-review, and commit.
- Then dispatch a spec-compliance reviewer subagent, then a code-quality reviewer subagent, per the skill's two-stage review process. Loop fixes until both approve.
- Mark the task complete in TodoWrite only after both reviews pass.
- Move to the next task immediately. Do NOT stop between tasks to summarize progress or ask "should I continue?" — execute continuously. The only valid reasons to stop: a BLOCKED status you cannot resolve after trying a more capable model, a genuine ambiguity the plan doesn't resolve, or all 17 tasks complete.
- Model selection per the skill's guidance: cheap/fast model for isolated pure-function tasks with a complete spec (e.g. Tasks 2, 3, 7, 8, 9, 10, 11, 12 — PKCE, token store, rate limiter, paginator, job poller, cache, query engine, error mapping), standard model for integration tasks (Tasks 4, 5, 6, 13, 15, 16 — OAuth flow, auth manager, HTTP client, the tool, server wiring), most capable model for the two reviewer roles on every task.

Constraints (non-negotiable, from this repo's standing safety rules and the PRD):
- No destructive git operations (force-push, reset --hard, discarding uncommitted work) without explicit user confirmation first.
- No push to any remote — none is configured, and pushing/creating one is out of scope for this handover.
- No live Zendesk account or OAuth client needed — every module takes injected fetch/dependencies; tests use tmp dirs and fakes only, never real network calls or real credentials.
- Do not add any destructive Zendesk operation (delete/merge/redact) anywhere — the PRD explicitly excludes these; if a subagent proposes one, reject it.
- Do not scope-creep into Plan 2 (tool modules), M7 (skills/commands/subagent), or M8 (packaging) — this session's job ends at the plan's Definition of Done.

When all 17 tasks are done and reviewed:
- Dispatch a final code-reviewer subagent over the entire implementation (all of zendesk-plugin/src and zendesk-plugin/tests).
- Then use superpowers:finishing-a-development-branch to present merge/PR/cleanup options to the user — do not decide unilaterally, and do not push or merge without the user's explicit go-ahead (there's no remote yet, so this will likely mean: merge the worktree branch back locally, or leave it for the user to decide).
- Report back with: which of the 17 tasks completed, test pass counts, and anything flagged DONE_WITH_CONCERNS along the way. Do not write a long narrative — a short task-by-task status list is enough.

Begin now: invoke superpowers:using-git-worktrees, then superpowers:subagent-driven-development, then start Task 1.
````

---

## Quality-control check on this handover

1. **Can the receiving session guess anything it shouldn't?** No — the plan file has zero placeholders (verified in self-review), and the prompt explicitly forbids scope creep into later milestones and destructive ops.
2. **Facts vs. assumptions separated?** Facts: file paths, decisions already made (quoted from PRD/plan, both committed to git). Assumption stated openly: no remote exists yet, so "finish" ends at local branch/worktree state, not a merged PR — the prompt says this explicitly rather than inventing a GitHub flow that doesn't exist here.
3. **Is the domain strictly bounded?** Yes — bounded to the 17 tasks in one named plan file; explicitly excludes Plan 2/M7/M8.

## What this handover deliberately does NOT include

- A GitHub issue/PR/CI pipeline — no remote is configured, and inventing a PO→Engineer→PeerReviewer→QA→PRReviewer cast (as the generic `meta-prompt-orchestrator` skill template assumes) would reference agents and a repo flow that don't exist in this project. If a GitHub remote and custom agent cast are added later, that skill becomes the right tool for cross-milestone tracking — not now.
- Any live Zendesk OAuth setup — deferred per the Phase 2 "mocks-first" decision; the plan's tests never touch a real account.
