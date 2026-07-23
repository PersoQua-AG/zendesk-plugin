// tests/register/analytics.test.ts
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { registerAnalyticsTools } from '../../src/register/analytics.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../../src/register/context.js';

type InputSchema = Record<string, z.ZodTypeAny>;

function registered(): Map<string, InputSchema> {
  const tools = new Map<string, InputSchema>();
  const server = {
    registerTool: (name: string, def: { inputSchema?: InputSchema }) => tools.set(name, def.inputSchema ?? {}),
  } as unknown as McpServer;
  const ctx = { httpClient: {}, cache: {}, securityLevel: 'standard', markdownDefault: true } as unknown as ToolContext;
  registerAnalyticsTools(server, ctx);
  return tools;
}

describe('registerAnalyticsTools', () => {
  const tools = registered();

  it('registers all six M6 analytics tools', () => {
    for (const name of [
      'zendesk_ticket_metrics',
      'zendesk_satisfaction_ratings',
      'zendesk_incremental_tickets',
      'zendesk_incremental_users',
      'zendesk_ticket_metric_events',
      'zendesk_report',
    ]) {
      expect(tools.has(name)).toBe(true);
    }
  });

  it('requires a positive integer start_time on the incremental tools', () => {
    const s = tools.get('zendesk_incremental_tickets')!.startTime;
    expect(s.safeParse(0).success).toBe(false);
    expect(s.safeParse(-1).success).toBe(false);
    expect(s.safeParse(1.5).success).toBe(false);
    expect(s.safeParse(1719_000_000).success).toBe(true);
  });

  it('makes ticketId optional on ticket_metrics', () => {
    const schema = tools.get('zendesk_ticket_metrics')!.ticketId;
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse(42).success).toBe(true);
  });
});
