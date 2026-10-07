---
name: ticket-manager
description: Write and manage the Zendesk ticket lifecycle from Claude — change status/priority/assignee/tags, post public replies or internal notes, and bulk re-tag or reassign. Use whenever the user wants to update, reply to, close, reopen, or bulk-edit one or more Zendesk tickets. For ranking the queue by what to work on next, use the triage-tickets skill instead. Enforces safe optimistic-concurrency updates, valid status transitions, append-by-default tags, and confirms before every write.
---

# Zendesk Ticket Manager

Drive the ticket lifecycle safely. Every state change is proposed to the user and only executed after they confirm.

## Golden rules

1. **Read before you write.** Fetch the ticket with `zendesk_get_ticket` first. It returns the current fields **and** the `updated_stamp` you need for `safe_update`.
2. **Confirm before every write.** Show the exact change (ticket id, field, old → new) and wait for the user's explicit "yes" before calling any write tool (`zendesk_update_ticket`, `zendesk_add_comment`, `zendesk_add_ticket_tags`, `zendesk_update_tickets_bulk`, `zendesk_create_tickets_bulk`).
3. **Never guess an assignee or group id.** Resolve names to ids with `zendesk_search_users` (e.g. `query:"name:Jane Doe role:agent"`) / `zendesk_list_groups` before assigning.
4. **Tags append by default.** Add tags with `zendesk_add_ticket_tags` (append). Only pass `replace:true` when the user explicitly asks to replace the entire tag set — and re-confirm, because it discards existing tags.

## Reading context

- One ticket: `zendesk_get_ticket` (`ticketId`) → status, priority, assignee, tags, `updated_stamp`.
- Several: `zendesk_get_tickets_many` (`ids`).
- Conversation: `zendesk_list_comments` (`ticketId`). Audit trail / who-changed-what: `zendesk_get_ticket_audits` (`ticketId`).
- Find tickets to act on: `zendesk_search` (`query`, e.g. `"status<solved priority:high"`, optional `type:"ticket"`) or, for large sets, `zendesk_search_export` (`query`, `type:"ticket"`).
- To slice a large cached response without re-fetching, call `zendesk_query` with the `cacheHandle` from the previous result and a JSONPath/jq expression.
- Field/form metadata: `zendesk_list_ticket_fields`, `zendesk_list_ticket_forms` (forms are Enterprise-gated and degrade gracefully).

## Updating a single ticket (safe_update)

1. `zendesk_get_ticket` → note `updated_stamp`.
2. Validate the requested status against the **lifecycle table** below.
3. Propose the change; on confirmation call `zendesk_update_ticket` with `ticketId`, the changed `fields` (`status` / `priority` / `assignee_id` / `group_id` / `subject` / `tags` / `custom_fields`), and `updatedStamp` set to the value from step 1.
4. If the tool returns a **409 conflict**, someone edited the ticket meanwhile. Re-fetch with `zendesk_get_ticket`, show the user the diff, and only proceed with `force:true` if they confirm they want to overwrite the concurrent change. Never pass `force:true` without that explicit confirmation.

## Lifecycle-state validation

Zendesk statuses form this machine: `new → open → pending → hold → solved → closed`. Validate the target status against the current status before proposing an update. The ❌ cells below are enforced by two tools and only those two: `zendesk_update_ticket` and `zendesk_update_tickets_bulk` read the current status and refuse a forbidden transition before any write, on `force:true` as well, and so are the two Rules that make `new` and `closed` refuse even their own status. A current status they cannot read is refused too, rather than assumed harmless, and so is a current status that is not one of the six columns below — a capitalisation difference or a status Zendesk adds later counts as unreadable, not as harmless. `zendesk_apply_macro_to_ticket` writes the preview verbatim and is NOT gated, so a macro that sets a status can still reach a cell the table refuses — check the table yourself before applying one.

| From \ To | new | open | pending | hold | solved | closed |
|---|---|---|---|---|---|---|
| **new**     | —  | ✅ | ✅ | ✅ | ✅ | via system |
| **open**    | ❌ | —  | ✅ | ✅ | ✅ | via system |
| **pending** | ❌ | ✅ | —  | ✅ | ✅ | via system |
| **hold**    | ❌ | ✅ | ✅ | —  | ✅ | via system |
| **solved**  | ❌ | ✅ (reopen) | ✅ | ✅ | — | via system |
| **closed**  | ❌ | ❌ | ❌ | ❌ | ❌ | — |

Rules:
- **`closed` is terminal.** A closed ticket cannot be reopened or edited. If the user asks to reopen a closed ticket, DO NOT attempt `zendesk_update_ticket`. Explain it is closed and offer to **create a linked follow-up ticket** (see below).
- **Never move a ticket back to `new`** — `new` is the birth state only. The tool refuses it from every state, so do not propose it: explain that `new` cannot be restored and offer the state the user actually wants (usually `open`).
- Reopening a `solved` ticket (→ `open`/`pending`) is allowed while it is still solved; confirm it is not already closed first.
- **`hold` may be plan-gated.** The on-hold status is an Enterprise/Professional feature on many plans; a `→ hold` update can fail on accounts where it is not enabled. If it errors, report that it is likely unavailable on this plan rather than retrying.
- `closed` is normally set by Zendesk automations, not manually — if the user asks to set `closed`, note that and confirm.

### Creating a follow-up for a closed ticket

To carry a closed ticket's context forward, create a **linked** follow-up. Both create tools accept the link, so use the single-create tool unless you are creating several at once:

```
zendesk_create_ticket  subject:"Follow-up: <original subject>"
                       comment:"<opening message>"
                       requesterId:<original requester id>
                       followupSourceId:<closed ticket id>
```

For several at once, `zendesk_create_tickets_bulk` takes the raw Zendesk field name per record:

```
zendesk_create_tickets_bulk  tickets:[{
  "subject": "Follow-up: <original subject>",
  "comment": { "body": "<opening message>", "public": true },
  "requester_id": <original requester id>,
  "via_followup_source_id": <closed ticket id>
}]
```

Pass the source id whenever the follow-up belongs to an existing closed ticket: omitting it creates an **unlinked** ticket whose history does not carry forward. Zendesk ignores `submitter_id` on a follow-up create. Confirm before creating.

## Replies and internal notes

**Reply contract:** this skill owns *posting* replies, not *wording* them. When the user wants a drafted customer reply, delegate the wording to the `support-agent` subagent (it drafts, it cannot write), show the user its draft, and only after they confirm do you post it with `zendesk_add_comment`. Short factual notes you may write directly.

- Public reply to the customer: `zendesk_add_comment` (`ticketId`, `body`, `public:true`). Body is Markdown→HTML by default; pass `markdown:false` to send raw HTML.
- Internal note (agents only): `zendesk_add_comment` with `public:false`. Always confirm which visibility the user wants before posting — a private note leaked publicly, or vice versa, is a real incident.
- Attachments: upload with `zendesk_upload_attachment` (base64) to get a token, then reference it in the comment.

## Bulk re-tag / reassign (async job)

For up to 100 tickets sharing one change, use `zendesk_update_tickets_bulk` (`ids`, `fields`). It runs as an auto-polled async job and returns a **per-record failure table** — surface it; do not report success on a boolean. Bulk update **skips** per-ticket `safe_update`, so it requires `force:true`; only pass it after warning the user that concurrent edits to those tickets may be silently overwritten. To bulk-create tickets, `zendesk_create_tickets_bulk` (`tickets`, ≤100).

## What this skill never does

- No deletes, merges, or spam marking — those tools do not exist in this plugin by design.
- No write without an explicit in-conversation confirmation.
- No `force:true` and no `replace:true` without a specific, re-confirmed instruction.
