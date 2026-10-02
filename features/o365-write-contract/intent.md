# Intent — o365-bridge write contract

- Issue: [#62](https://github.com/PersoQua-AG/zendesk-plugin/issues/62) — "o365-bridge is promised read-safe, but it writes to Zendesk and triggers M365 side effects" (label: bug)
- Repo: `PersoQua-AG/zendesk-plugin` · integration branch: `development` · branch: `fix/62-o365-write-contract` (from `development` @ `3ee1d43`)
- Refs: #33 (open) · PR #47 (pr-reviewer open point 3)
- Zoho: PE-8 (`.persoqua.yml:zoho_project_key`) — no task created yet
- Size: **S** — no `src/` change; one contract paragraph in two markdown files, one new test block on the existing PR-#47 harness, one fixture edit, plus two mandatory control runs.

## Story

As the owner who relies on #33's promise that "the bridge stays read-safe", I want the
o365-bridge's real side-effect contract stated once and its Zendesk write set pinned by a test, so
that the promise matches what the skill does and a new write cannot slip in unnoticed.

## Exit criteria (verbatim from issue #62)

The following four blocks are copied word for word from issue #62. They are the only definition of
done. Do not reword, extend or drop a line.

### Required behaviour

- The contract is stated truthfully in one place the owner accepts: the bridge reads Zendesk, may write exactly one kind of Zendesk change (a comment), and causes M365 side effects only after explicit confirmation. Either the #33 wording or the skill text is corrected. The PR says which one.
- The set of Zendesk write tools the bridge skill and `/escalate` name is pinned. Adding any other write tool turns CI red.

### Acceptance criteria

```gherkin
Feature: The o365-bridge side-effect contract is stated and pinned

  Scenario: Declared write set (happy path)
    Given skills/o365-bridge/SKILL.md and commands/escalate.md
    When the Zendesk tool names they mention are collected
    Then the write tools among them are exactly {zendesk_add_comment}

  Scenario: An extra write tool appears (negative)
    Given a working copy of skills/o365-bridge/SKILL.md that also names zendesk_update_ticket
    When the pin runs
    Then it fails and names zendesk_update_ticket

  Scenario: Contract wording
    Given the corrected contract text
    Then it no longer says "read-safe" without qualification
    And it names the Zendesk comment write and the M365 side effects
```

### Acceptance tests

1. **Deterministic, new test in `tests/skills/o365-bridge.test.ts` (PR #47 harness).** Extract every `zendesk_*` name from both files and classify it as a write if its tool name appears in the probe's pinned write list (`tests/skills/probe.test.ts:6-12`, entries of the form `tool: METHOD path`). Assert that the write set equals `['zendesk_add_comment']`.
   - **Mandatory control run:** add `zendesk_update_ticket` to a working copy of `SKILL.md` (as in the S0 mutation for OB-3). The test must go RED. Paste the output, then revert.
   - A second control: remove the `:37` mention. The test must still be green, since the write set is still `{zendesk_add_comment}` via `:42`, which proves the test does not depend on line numbers.
2. **Recorded, update `tests/skills/fixtures/o365-bridge/ob-3-failcheck.json`.** `expected` must describe the corrected contract, and `status` moves off `unenforced` for the pinned half. It is structurally checked by `tests/skills/recorded.test.ts`, and its behaviour is never asserted in CI.
3. `tests/plugin/claude-layer.test.ts` stays unmodified and green.

### Gate

Gate: `npm run build && npm test` is green.

## Verified file citations (this worktree, `fix/62-o365-write-contract` @ `3ee1d43`)

Every path and line the issue names was re-checked here. Shifts against the issue's own citations
(which were taken on `main` @ `b71c9bd` / PR #47 head `295787a`) are called out.

| Issue citation | Status here | Today's evidence |
|---|---|---|
| `grep -rn "read-safe" skills commands` is empty | holds | command returns no match; the skill text never claims read-safety |
| `zendesk_add_comment` in "Attach knowledge", `SKILL.md:37` | holds, same line | `skills/o365-bridge/SKILL.md:37` — "reference its link in the ticket via `zendesk_add_comment` (usually an internal note, `public:false`)" |
| audit note, `SKILL.md:42` | holds, same line | `skills/o365-bridge/SKILL.md:42` — "optionally record it on the ticket with an internal `zendesk_add_comment`" |
| `/escalate` write, `commands/escalate.md:11` | holds, same line | `commands/escalate.md:11` — "optionally record an internal note on the ticket with `zendesk_add_comment` (`public:false`)" |
| send mail `:33`, calendar invite `:35`, Teams post `:31` | holds, same lines | `skills/o365-bridge/SKILL.md:31` (Teams post), `:33` (`outlook_send_mail`), `:35` (`outlook_create_event`) |
| gated only by the instruction to confirm, `:41` | holds, same line | `skills/o365-bridge/SKILL.md:41` — "Every outbound action … propose it and get explicit confirmation first" |
| read tool set `:22-24` | holds, same lines | `skills/o365-bridge/SKILL.md:22` `zendesk_get_ticket`, `:23` `zendesk_list_comments`, `:24` `zendesk_query` |
| `tests/skills/o365-bridge.test.ts` exists only at PR #47 head | **superseded** — present on `development` now | `tests/skills/o365-bridge.test.ts:1-89`; covers OB-1 (`:19`, `:45`, `:59`) and OB-4 (`:78`) only, as the issue states |
| whole `tests/skills/*` tree | **superseded** — present on `development` now | `tests/skills/` holds `probe.ts`, `probe.test.ts`, `recorded.test.ts`, `o365-bridge.test.ts`, `fixtures/` and six further skill tests |
| OB-3 fixture `status: unenforced`, `ob-3-failcheck.json:6` | holds, same line | `tests/skills/fixtures/o365-bridge/ob-3-failcheck.json:6` → `"status": "unenforced"` |
| probe's pinned write list, `tests/skills/probe.test.ts:6-12` | **line range shifted** — the list is `tests/skills/probe.test.ts:6-31` | `const WRITES = [` at `:6`, closing `];` at `:31`; 24 entries, all of the form `tool: METHOD path` as described |
| `tests/plugin/claude-layer.test.ts` | exists | `tests/plugin/claude-layer.test.ts` present, untouched on this branch |
| #33 wording "bridge stays read-safe; reaches outside Zendesk only where declared" | holds | issue #33 body, bullet "**o365-bridge:**"; issue #33 is **OPEN**, author `renepf` |
| S0 source row OB-3, finding 7 | holds | `ops` `projects/zendesk-plugin/docs/2026-09-24-skill-evals-s0-boundary.md:53` (OB-3 row, verdict **U**) and `:81` (finding 7) |

### Notes for the engineer (not exit criteria)

- `writesIn` (`tests/skills/probe.ts:148-149`) classifies a *runtime* request as a write by
  `!r.startsWith('GET ')`. Acceptance test 1 needs the *static* classification against the
  `WRITES` names in `tests/skills/probe.test.ts:6-31`, not `writesIn` itself.
- `tests/skills/recorded.test.ts:15` restricts `status` to `recorded`, `unenforced` or
  `pending-owner-decision`. "Moves off `unenforced`" therefore means one of the other two.

## Open owner decision (does not block the build)

**D1 — Should #33's wording be corrected as well?** The engineer corrects the **skill text** and
says so in the PR, as "The PR says which one" permits. Editing the body of the owner's open issue
#33 is not an engineer action. René decides separately whether #33's `o365-bridge` bullet is
rewritten. No acceptance test and no gate touches #33, so this stays outside the PR.
