---
name: data-analyst
description: Produce Zendesk support analytics over a date range — ticket volume and trend, SLA-breach counts, first-reply-time and resolution-time (both calendar and business-hours), and CSAT. Use whenever the user asks for a report, metrics, KPIs, SLA performance, response/resolution times, satisfaction, or ticket trends over a period. Built on the composite report tool plus metrics, CSAT, and incremental-export readers.
---

# Zendesk Data Analyst

Turn a date range into a support report. All tools here are READ-only.

## Time inputs

Every analytics tool takes **`startTime` as unix epoch seconds** (and optional `endTime`, defaulting to now). Convert the user's phrasing first:
- "last 30 days" → `startTime = now - 30*24*3600`.
- "June 2026" → `startTime` = 2026-06-01 00:00 UTC, `endTime` = 2026-07-01 00:00 UTC.
State the resolved UTC window back to the user so the range is unambiguous.

## Preferred path — one composite call

For a standard report, call **`zendesk_report`** (`startTime`, optional `endTime`). It returns, over the window:
- ticket **volume**,
- **first-reply-time** and **resolution-time**, each reported **twice**: calendar (wall-clock elapsed) and **business-hours** (only counting configured working time),
- **SLA-breach count**, and
- a **CSAT** summary (good/bad + satisfaction %).

It returns a summary + a `cacheHandle`. To drill into a specific slice (e.g. the list of breaching ticket ids, or per-priority counts) call `zendesk_query` with that `cacheHandle` and a JSONPath/jq expression — no re-fetch, no extra API cost.

## Business-hours basis (calendar vs business)

Business-hours FRT/resolution use the plugin's configured `timezone`, `work_hours`, and `workdays` (PRD §8). Defaults when unset: UTC, 09:00–17:00, Monday–Friday. If the user's expectation differs (e.g. a support desk in Europe/Berlin, or weekend coverage), tell them these come from plugin config and cannot be overridden per-call — they must set `ZENDESK_TIMEZONE` / `ZENDESK_WORK_HOURS` / `ZENDESK_WORKDAYS` in the plugin config. Always label which basis a number uses; never present business-hours and calendar figures without saying which is which.

## Component tools (when the composite is not enough)

- `zendesk_ticket_metrics` — reply/resolution timings. Omit `ticketId` to list all (cursor-paginated); pass `ticketId` for one ticket's metrics.
- `zendesk_satisfaction_ratings` — CSAT ratings; optional `startTime` filters server-side. Comment text is fenced/screened.
- `zendesk_incremental_tickets` (`startTime`) — bulk-sync tickets changed since a time. **Throttled at 10 req/min** — use for backfills, not tight loops; expect it to be slower.
- `zendesk_incremental_users` (`startTime`) — bulk-sync users; same 10 req/min bucket.
- `zendesk_ticket_metric_events` (`startTime`) — the raw metric events (SLA breach/fulfilment, first-reply, etc.); same 10 req/min bucket. This is the source of SLA-breach detail.

## Presenting results

- Lead with the resolved window and the headline numbers (volume, median FRT calendar + business, SLA breaches, CSAT %).
- For trends, bucket by day/week from the cached pull via `zendesk_query`.
- Round durations to sensible units (minutes/hours) and always attach the calendar-vs-business label.
- If a figure is unavailable (e.g. no CSAT ratings in the window), say so explicitly rather than reporting zero as if it were a measurement.
