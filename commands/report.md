---
description: Generate a Zendesk analytics report for a date range (volume, SLA, reply/resolution times, CSAT).
argument-hint: "<range, e.g. last-30-days or 2026-06-01..2026-06-30>"
---

Produce a Zendesk report for the range: **$ARGUMENTS**.

Use the `data-analyst` skill. Resolve the range into `startTime` (and `endTime`) as unix epoch **seconds** — interpret shorthand like `last-30-days` / `last-7-days` / `this-month`, or an explicit `YYYY-MM-DD..YYYY-MM-DD` window (end-exclusive). State the resolved UTC window back to the user, then call `zendesk_report` with those times.

Present the headline numbers: ticket volume, first-reply-time and resolution-time (label calendar vs business-hours for each), SLA-breach count, and CSAT %. If the user asks to drill in, use `zendesk_query` on the report's cache handle rather than re-fetching. If no range was given, default to the last 30 days and say so.
