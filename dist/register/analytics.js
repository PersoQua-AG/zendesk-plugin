import { z } from 'zod';
import { okWithHandle } from '../tools/result.js';
import { ticketMetrics, satisfactionRatings, MAX_RATINGS_CAP } from '../tools/analytics/metrics.js';
import { incrementalTickets, incrementalUsers, ticketMetricEvents, MAX_INCREMENTAL_CAP, MAX_EVENTS_CAP, } from '../tools/analytics/incremental.js';
import { report } from '../tools/analytics/report.js';
import { DEFAULT_BUSINESS_HOURS } from '../tools/analytics/business-hours.js';
import { DEFAULT_LIST_CAP, MAX_PAGE_SIZE } from '../tools/cbp-list.js';
const idSchema = z.number().int().positive();
const startTimeSchema = z.number().int().positive(); // unix seconds
const pageSizeSchema = z.number().int().positive().max(MAX_PAGE_SIZE).optional();
export function registerAnalyticsTools(server, ctx) {
    const { httpClient, cache, securityLevel } = ctx;
    const reportConfig = ctx.reportConfig ?? DEFAULT_BUSINESS_HOURS;
    server.registerTool('zendesk_ticket_metrics', {
        description: 'Read ticket metrics (reply/resolution timings). Omit ticketId to list all (cursor-paginated); pass ticketId for one ticket. Screened, cached.',
        inputSchema: { ticketId: idSchema.optional(), pageSize: pageSizeSchema, maxRecords: z.number().int().positive().max(DEFAULT_LIST_CAP).optional() },
    }, async (args) => okWithHandle(await ticketMetrics(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_satisfaction_ratings', {
        description: 'List CSAT satisfaction ratings (cursor-paginated, comments fenced, screened). Optional start_time (unix seconds) filters server-side.',
        inputSchema: { startTime: startTimeSchema.optional(), maxRecords: z.number().int().positive().max(MAX_RATINGS_CAP).optional() },
    }, async (args) => okWithHandle(await satisfactionRatings(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_incremental_tickets', {
        description: 'Bulk-sync tickets updated since start_time (unix seconds) via incremental cursor export. Throttled at 10 req/min. Screened, cached.',
        inputSchema: { startTime: startTimeSchema, maxRecords: z.number().int().positive().max(MAX_INCREMENTAL_CAP).optional() },
    }, async (args) => okWithHandle(await incrementalTickets(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_incremental_users', {
        description: 'Bulk-sync users updated since start_time (unix seconds) via incremental cursor export. Throttled at 10 req/min. Screened, cached.',
        inputSchema: { startTime: startTimeSchema, maxRecords: z.number().int().positive().max(MAX_INCREMENTAL_CAP).optional() },
    }, async (args) => okWithHandle(await incrementalUsers(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_ticket_metric_events', {
        description: 'Bulk-sync ticket metric events since start_time (unix seconds) via time-based incremental export. Throttled at 10 req/min. Screened, cached.',
        inputSchema: { startTime: startTimeSchema, maxRecords: z.number().int().positive().max(MAX_EVENTS_CAP).optional() },
    }, async (args) => okWithHandle(await ticketMetricEvents(httpClient, cache, args, securityLevel)));
    server.registerTool('zendesk_report', {
        description: 'Composite analytics report over a date range: ticket volume, first-reply-time and resolution-time (calendar AND business-hours), SLA-breach count, and CSAT. Requires start_time (unix seconds); end_time defaults to now. Business-hours basis comes from timezone/work_hours/workdays config.',
        inputSchema: { startTime: startTimeSchema, endTime: startTimeSchema.optional() },
    }, async ({ startTime, endTime }) => okWithHandle(await report(httpClient, cache, { startTime, endTime }, reportConfig, securityLevel)));
}
