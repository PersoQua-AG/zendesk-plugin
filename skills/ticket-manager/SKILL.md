---
name: ticket-manager
description: Manage the full Zendesk ticket lifecycle from Claude — read context, change status/priority/assignee/tags, post public replies or internal notes, and bulk re-tag or reassign. Use whenever the user wants to triage, update, reply to, close, reopen, or bulk-edit one or more Zendesk tickets. Enforces safe optimistic-concurrency updates, valid status transitions, append-by-default tags, and confirms before every write.
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

Zendesk statuses form this machine: `new → open → pending → hold → solved → closed`. Validate the target status against the current status before proposing an update.

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
- **Never move a ticket back to `new`** — `new` is the birth state only; warn and confirm if requested.
- Reopening a `solved` ticket (→ `open`/`pending`) is allowed while it is still solved; confirm it is not already closed first.
- `closed` is normally set by Zendesk automations, not manually — if the user asks to set `closed`, note that and confirm.

### Creating a follow-up for a closed ticket

To carry a closed ticket's context forward, create a **linked** follow-up. The link field `via_followup_source_id` is only settable through a raw ticket record, so use `zendesk_create_tickets_bulk` with a single record:

```
zendesk_create_tickets_bulk  tickets:[{
  "subject": "Follow-up: <original subject>",
  "comment": { "body": "<opening message>", "public": true },
  "requester_id": <original requester id>,
  "via_followup_source_id": <closed ticket id>
}]
```

(For an unlinked new ticket, `zendesk_create_ticket` with `subject` + `comment` is simpler — mention the trade-off and let the user choose.) Confirm before creating.

## Replies and internal notes

- Public reply to the customer: `zendesk_add_comment` (`ticketId`, `body`, `public:true`). Body is Markdown→HTML by default; pass `markdown:false` to send raw HTML.
- Internal note (agents only): `zendesk_add_comment` with `public:false`. Always confirm which visibility the user wants before posting — a private note leaked publicly, or vice versa, is a real incident.
- Attachments: upload with `zendesk_upload_attachment` (base64) to get a token, then reference it in the comment.

## Bulk re-tag / reassign (async job)

For up to 100 tickets sharing one change, use `zendesk_update_tickets_bulk` (`ids`, `fields`). It runs as an auto-polled async job and returns a **per-record failure table** — surface it; do not report success on a boolean. Bulk update **skips** per-ticket `safe_update`, so it requires `force:true`; only pass it after warning the user that concurrent edits to those tickets may be silently overwritten. To bulk-create tickets, `zendesk_create_tickets_bulk` (`tickets`, ≤100).

## What this skill never does

- No deletes, merges, or spam marking — those tools do not exist in this plugin by design.
- No write without an explicit in-conversation confirmation.
- No `force:true` and no `replace:true` without a specific, re-confirmed instruction.
