---
name: triage-tickets
description: Triage the open Zendesk queue — pull open and pending tickets, rank them by SLA-breach risk and priority, and summarize what needs attention now. Use when the user asks what to work on next, to triage or prioritize the queue, or for a quick read of at-risk tickets. Read-only — proposes actions but makes no changes.
---

# Zendesk Ticket Triage

Give the agent a ranked "work on these next" list. This skill is **read-only** — it never writes. If the user then wants to act, hand off to the `ticket-manager` skill.

## Pull the queue

Choose the narrowest source available:
- A saved view is usually best: `zendesk_list_views` to find one (e.g. "Open tickets"), then `zendesk_execute_view` (`viewId`) for its tickets, or `zendesk_view_count` (`viewId`) for just a number.
- Otherwise search: `zendesk_search` with `query:"status<solved"` (optionally `type:"ticket"`), or `zendesk_search_export` (`query`, `type:"ticket"`) for large queues.
- Or `zendesk_list_tickets` for a raw list.

## Assess SLA risk

- `zendesk_ticket_metrics` (omit `ticketId` to list) exposes reply/resolution timings and any breach-relevant fields per ticket.
- `zendesk_ticket_metric_events` (`startTime`, unix seconds — throttled 10 req/min) gives breach/fulfilment events for deeper SLA analysis over a recent window.
- Use `zendesk_query` on a cached pull to join metrics onto the queue without re-fetching.

## Rank and summarize

Order by, in priority: (1) already-breached or imminently-breaching SLA, (2) `urgent`/`high` priority, (3) oldest `pending`/awaiting-agent, (4) age since last update. Produce a short table — id, subject (truncated), priority, status, SLA state, why it ranks where it does. Keep it scannable; do not dump raw JSON. Offer to open any ticket in full (`/zendesk:ticket <id>`) or to act on it via the ticket-manager skill.
