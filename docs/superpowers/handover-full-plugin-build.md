# Handover — Full Plugin Build Loop (M0 → M8)

**Date:** 2026-07-15
**Repo:** [PersoQua-AG/zendesk-plugin](https://github.com/PersoQua-AG/zendesk-plugin) (private)
**Scope:** the *entire* PRD, all 9 milestones — not just the Foundation plan.

## Why this document exists

`docs/superpowers/handover-zendesk-plugin-foundation.md` hands over **one** plan (M0+M1, already written). This document hands over the **whole build**: it drives a fresh Claude Code session through writing and executing every remaining plan (M2–M8) in sequence, immediately after Foundation, with no human check-in between milestones. Use this when you want the plugin built end-to-end in one continuous run rather than milestone-by-milestone with a human in the loop.

It is still not a GitHub-issue/PR pipeline — same reasoning as the Foundation handover: work happens on one local feature branch in a worktree; nothing is pushed to `origin/main` or merged without the user's explicit go-ahead at the end.

## What "loop" means here

This is **one continuous session**, not a scheduled/recurring job. The orchestrator does not stop between tasks or between milestones to report progress or ask permission. For each milestone from M2 onward, no implementation plan exists yet — the orchestrator writes one (`superpowers:writing-plans`, same no-placeholder/TDD discipline as the Foundation plan), then executes it (`superpowers:subagent-driven-development`), then moves to the next milestone. It repeats that write→execute cycle until M8 is done.

---

## The Orchestrator Prompt

Paste everything in the fenced block below as the **first message** of a fresh session in this repo (`/Users/pfist/Developer/Otterstedt/persoqua/Claude Plugins/Zendesk Plugin`).

````
I'm building the complete Zendesk Claude Code plugin, start to finish, in one continuous run. You are the main-thread orchestrator — you do NOT write code yourself. You dispatch fresh subagents for every unit of work and review what they produce.

Read these first, in full, before doing anything else:
1. HANDOVER.md — project orientation, current status, locked decisions.
2. docs/superpowers/specs/2026-07-09-zendesk-plugin-prd.md — the approved PRD. This is the source of truth for every milestone's scope. Do not re-litigate decisions already made in it. Section 9 lists the milestones you will work through: M0, M1, M2, M3, M4, M5, M6, M7, M8, in that order.
3. docs/superpowers/plans/2026-07-09-zendesk-plugin-foundation.md — the already-written implementation plan for M0+M1 ("Plan 1"). You do not need to write this one, only execute it.

## Setup (once, before Milestone 1)

Use superpowers:using-git-worktrees to set up an isolated workspace. Consent is pre-granted — do not ask the user, just do it. Prefer a native worktree tool (e.g. EnterWorktree) if available. Branch name: feature/zendesk-plugin-full-build. All work for every milestone below happens on this one branch — do not create a new branch per milestone.

## The per-milestone loop

For M0+M1 (Plan 1 already exists): skip straight to "Execute" below using the existing plan file.

For every milestone from M2 through M8 (in PRD order — do not reorder, do not skip one because it looks smaller):

**Write:**
- Invoke superpowers:writing-plans to produce a new implementation plan scoped to exactly that milestone's line in PRD §9, using the matching tool/skill inventory from PRD §6/§7 for that area. One plan per milestone, saved to docs/superpowers/plans/YYYY-MM-DD-<milestone-name>.md (use today's date). Follow the same discipline as the Foundation plan: bite-sized TDD tasks, complete runnable code in every step, no placeholders ("TBD", "handle edge cases", "similar to Task N" are plan failures — fix them before moving on), a file-structure section, and a self-review pass (spec coverage, placeholder scan, type consistency against modules built in earlier milestones) before you consider the plan done.
- Every new milestone's code must reuse the Foundation's infra (RateLimiter, ZendeskHttpClient, paginateCbp/collectAllCbp, pollJobToCompletion, ResponseCache, runQuery, screenContent, AuthManager) rather than reinventing it. If a milestone's plan would duplicate that infra, that's a bug in the plan — fix it before executing.
- Commit the plan file itself (not yet the implementation) before moving to Execute.

**Execute:**
- Invoke superpowers:subagent-driven-development on that milestone's plan. Read the plan file once yourself, extract all tasks with full text, create a TodoWrite entry per task.
- Per task: dispatch an implementer subagent with the task's full text and enough surrounding context (it must never read the plan file itself — you paste the content in). Let it implement, test, self-review, commit.
- Then dispatch a spec-compliance reviewer subagent, then a code-quality reviewer subagent, per the skill's two-stage process. Loop fixes until both approve. Do not start quality review before spec compliance is clean.
- Mark each task complete in TodoWrite only after both reviews pass.
- Model selection per the skill's guidance: cheap/fast model for isolated, fully-specified mechanical tasks (pure functions, single-file CRUD wrappers with a clear fixture); standard model for integration tasks (wiring a new tool module into server.ts, multi-file coordination); most capable model for both reviewer roles on every task, and for writing each milestone's plan in the first place (that's a design/architecture task).
- When every task in the milestone is done and reviewed, dispatch one milestone-level code reviewer subagent over everything that milestone added, before moving to the next milestone.

**Then immediately continue to the next milestone's Write step. Do not stop between milestones to summarize progress, ask "should I continue?", or wait for approval. Execute continuously through M2 → M3 → M4 → M5 → M6 → M7 → M8.**

## Non-negotiable constraints (apply to every milestone, no exceptions)

- **No destructive Zendesk operations, ever.** No delete, destroy_many, permanent delete, merge, or comment redaction tool, in any milestone. If a subagent proposes one (even "just for completeness" or "the API supports it"), reject it and have the subagent remove it. This is a PRD-level exclusion (§2 Non-Goals N1), not a style preference.
- **No live Zendesk account or OAuth client needed at any point.** Every module takes injected fetch/dependencies. All tests use tmp dirs, fakes, and fixtures — never real network calls, never real credentials. This holds for M2–M8 exactly as it held for the Foundation.
- **Professional-tier limits respected:** rate limiter stays at 400 req/min; ticket forms and custom-role tooling stay read-only (Enterprise-gated features are never given write tools) — see PRD §4.
- **Known Zendesk traps must be guarded in code, not just documented** (PRD §5.2, §13, cross-cutting checklist in the research): tags are appended via POST by default, never blind PUT-replace; macro `apply` is preview-only until the user confirms, then persisted via a follow-up PUT; ticket updates use safe_update optimistic concurrency (409 → re-fetch + confirm, don't silently overwrite); async bulk jobs (create_many/update_many) are always polled to completion via the Foundation's pollJobToCompletion, never treated as synchronous; CBP pagination only, never hand-rolled offset pagination; all inbound ticket/comment/attachment content passes through the Foundation's screenContent before reaching any downstream summarization or the model.
- **No new dependencies beyond what Plan 1 already introduced** (@modelcontextprotocol/sdk, zod, vitest — plus node-zendesk when M2 wires it, per PRD §5) without flagging it to the user first and getting a go-ahead. Don't silently add an HTTP library, a date library, a validation library, etc.
- **Git discipline:** commit freely on the feature branch as work completes — that's expected and doesn't need per-commit confirmation. Do NOT push to origin, do NOT merge into main, do NOT force-push or rewrite history, without the user's explicit go-ahead. This branch is your workspace until the human says otherwise.
- **Stay inside PRD scope.** No Talk/Chat/Sunshine Conversations, no Sell/CRM, no features not named in the PRD. If you find yourself building something the PRD doesn't mention, stop and check — you've likely misread a milestone's scope.

## When to stop (only these three reasons)

1. A BLOCKED status from an implementer subagent that you cannot resolve even after escalating to a more capable model and breaking the task down smaller.
2. A genuine ambiguity that neither the PRD nor the milestone's plan resolves (not "which variable name is nicer" — an actual scope or behavior question only the user can answer).
3. All 9 milestones (M0–M8) are complete and reviewed.

Do not stop for anything else. No "here's my progress so far, should I continue?" No pausing after each milestone to summarize. If you hit one of the three stop conditions, say so clearly and state exactly what you need from the user.

## Finishing

Once M8 (packaging) is done and reviewed:
- Confirm `claude plugin validate --strict` passes.
- Confirm the full test suite passes across every milestone's tests together (not just the milestone that just finished — run the whole suite to catch cross-milestone regressions).
- Use superpowers:finishing-a-development-branch to present merge/PR/cleanup options to the user. Do not decide unilaterally, and do not push, merge, or open a PR without the user's explicit go-ahead.
- Report back with a milestone-by-milestone status list (which plans were written, task counts, test pass counts, anything flagged DONE_WITH_CONCERNS), not a long narrative.

Begin now: invoke superpowers:using-git-worktrees, then execute Plan 1 (M0+M1) via superpowers:subagent-driven-development, then start the write→execute loop at M2.
````

---

## Notes for whoever runs this

- This is a genuinely long-running task — realistically many hours of agent time across 7 plans (M2–M8) plus their execution, on top of Plan 1. Expect it to span several context windows; the harness compresses context automatically as needed, so no special handling is required for that.
- If you'd rather review each milestone's plan before it's executed (safer, slower), don't use this document — use the Foundation-only handover (`handover-zendesk-plugin-foundation.md`) for M0+M1, then run `superpowers:writing-plans` yourself for M2 and check in before executing, repeating per milestone. This full-build prompt is the "no human in the loop until it's all done" version, for when you're confident enough in the PRD to let it run.
- Same quality-control check as the Foundation handover applies here: nothing here invents scope beyond the PRD, facts (PRD decisions, existing Plan 1 content) are separated from the one open assumption (that each milestone's plan-writing agent will correctly re-derive task granularity from the PRD's tool tables), and the domain is bounded to exactly PRD §9's milestone list — no more, no less.
