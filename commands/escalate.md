---
description: Escalate a Zendesk ticket to Microsoft 365 — post to Teams and/or email via Outlook.
argument-hint: "<ticket-id>"
disable-model-invocation: true
---

Escalate ticket **$ARGUMENTS** via Microsoft 365.

If no numeric ticket id was provided, ask for one and stop.

Use the `o365-bridge` skill. First detect whether the Microsoft 365 connector is available; if it is not, tell the user how to connect it (Claude settings → Connectors → Microsoft 365 → authorize) and stop without touching Zendesk. If it is available, build the ticket summary from `zendesk_get_ticket` + `zendesk_list_comments` (plus the ticket URL), then confirm the escalation target and channel with the user before posting to Teams / sending or drafting via Outlook. Prefer a draft for customer-facing content. After escalating, optionally record an internal note on the ticket with `zendesk_add_comment` (`public:false`) for the audit trail — with confirmation.
