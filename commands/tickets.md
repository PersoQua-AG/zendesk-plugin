---
description: Show a dashboard of open and pending Zendesk tickets, ranked by urgency.
argument-hint: "[optional filter, e.g. priority:high]"
---

Show the open-ticket dashboard.

Pull the current unsolved queue with `zendesk_search` using the query `status<solved $ARGUMENTS` (trim to `status<solved` if no argument was given) and `type:"ticket"`; for a large queue use `zendesk_search_export` with `type:"ticket"` instead. If a saved "Open tickets" view exists (`zendesk_list_views`), you may execute it with `zendesk_execute_view` instead.

Rank and present the results the way the `triage-tickets` skill does — by SLA risk then priority then age — as a compact scannable table: id, subject (truncated), requester, priority, status, last-updated. Do not dump raw JSON. End by offering `/zendesk:ticket <id>` for a full view of any row. This is read-only; make no changes.
