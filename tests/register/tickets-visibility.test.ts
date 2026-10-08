// tests/register/tickets-visibility.test.ts
// #64: internal-by-default is only a safeguard if the SURFACES carry it. Two things the tool-level
// tests cannot see: (1) bulk create forwards its records to create_many untouched, so its default
// lives in the registered schema and only a parse proves it; (2) a flipped default the description
// never mentions is a trap for the caller, not a safeguard — so the prose is pinned too.
import { describe, it, expect, vi } from 'vitest';
import type { z } from 'zod';
import { registerTicketTools } from '../../src/register/tickets.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../../src/register/context.js';

interface ToolDef {
  description?: string;
  inputSchema?: Record<string, z.ZodTypeAny> | z.ZodTypeAny;
}

function registeredTools(): Map<string, ToolDef> {
  const defs = new Map<string, ToolDef>();
  const server = {
    registerTool: (name: string, def: ToolDef) => defs.set(name, def),
  } as unknown as McpServer;
  const ctx = { httpClient: {}, cache: { save: vi.fn() }, securityLevel: 'standard', markdownDefault: true } as unknown as ToolContext;
  registerTicketTools(server, ctx);
  return defs;
}

function def(name: string): ToolDef {
  const found = registeredTools().get(name);
  if (!found) throw new Error(`${name} was not registered`);
  return found;
}

function bulkTicketsSchema(): z.ZodTypeAny {
  const schema = def('zendesk_create_tickets_bulk').inputSchema as Record<string, z.ZodTypeAny>;
  return schema.tickets;
}

const RECORD = { subject: 'Printer down', comment: { body: 'opening message' } };

describe('zendesk_create_tickets_bulk visibility default', () => {
  it('parses an omitted comment.public into an internal note', () => {
    const parsed = bulkTicketsSchema().parse([RECORD]) as Array<{ comment: { public: boolean } }>;
    expect(parsed[0].comment.public).toBe(false);
  });

  it('keeps an explicit public:true', () => {
    const parsed = bulkTicketsSchema().parse([{ ...RECORD, comment: { ...RECORD.comment, public: true } }]) as Array<{
      comment: { public: boolean };
    }>;
    expect(parsed[0].comment.public).toBe(true);
  });

  it('keeps an explicit public:false', () => {
    const parsed = bulkTicketsSchema().parse([{ ...RECORD, comment: { ...RECORD.comment, public: false } }]) as Array<{
      comment: { public: boolean };
    }>;
    expect(parsed[0].comment.public).toBe(false);
  });
});

describe('the comment-writing tools state what omitting public means', () => {
  it('zendesk_add_comment names the internal default', () => {
    const description = def('zendesk_add_comment').description ?? '';
    expect(description).toMatch(/omitting public/i);
    expect(description).toMatch(/internal/i);
  });

  it('zendesk_create_ticket names the internal default', () => {
    const description = def('zendesk_create_ticket').description ?? '';
    expect(description).toMatch(/internal/i);
    expect(description).toMatch(/public:true/);
  });
});
