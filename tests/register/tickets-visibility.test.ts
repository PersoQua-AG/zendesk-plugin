// tests/register/tickets-visibility.test.ts
// #64: internal-by-default is only a safeguard if the SURFACES carry it. Two things the tool-level
// tests cannot see: (1) bulk create forwards its records to create_many untouched, so its default
// lives in the registered schema and only a parse proves it; (2) a flipped default the description
// never mentions is a trap for the caller, not a safeguard — so the prose is pinned too.
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
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
  it.each([
    ['an omitted', undefined, false],
    ['an explicit true', true, true],
    ['an explicit false', false, false],
  ] as const)('parses %s comment.public into the internal-by-default result', (_label, passed, expected) => {
    const comment = passed === undefined ? RECORD.comment : { ...RECORD.comment, public: passed };
    const parsed = bulkTicketsSchema().parse([{ ...RECORD, comment }]) as Array<{ comment: { public: boolean } }>;
    expect(parsed[0].comment.public).toBe(expected);
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

  // The surface whose behaviour changed most: Zendesk itself published before #64.
  it('zendesk_create_tickets_bulk names the internal default', () => {
    const description = def('zendesk_create_tickets_bulk').description ?? '';
    expect(description).toMatch(/internal/i);
    expect(description).toMatch(/comment\.public:true/);
  });
});

// #64: the PUBLISHED input schema is this change's deliverable — it is what tells a model it must
// pass public:true. Measured: keeping the bulk parse default but gutting the two single-tool
// `.default(false)` and all three `.describe()` texts left the suite 205/1701 green, so the parse
// tests above see only one of the six published facts. These pin what a client actually receives.
interface SchemaNode {
  default?: unknown;
  description?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
}

function publishedSchema(name: string): SchemaNode {
  const { inputSchema } = def(name);
  if (!inputSchema) throw new Error(`${name} publishes no input schema`);
  const obj = inputSchema instanceof z.ZodType ? inputSchema : z.object(inputSchema as Record<string, z.ZodTypeAny>);
  return toJsonSchemaCompat(obj, { strictUnions: true }) as SchemaNode;
}

function prop(node: SchemaNode, key: string): SchemaNode {
  const child = node.properties?.[key];
  if (!child) throw new Error(`no published property \`${key}\``);
  return child;
}

// The object that owns `public`: the tool args themselves, or a bulk record's nested comment.
const OWNERS: ReadonlyArray<readonly [string, (s: SchemaNode) => SchemaNode]> = [
  ['zendesk_add_comment', (s) => s],
  ['zendesk_create_ticket', (s) => s],
  [
    'zendesk_create_tickets_bulk',
    (s) => {
      const record = prop(s, 'tickets').items;
      if (!record) throw new Error('tickets publishes no item schema');
      return prop(record, 'comment');
    },
  ],
];

describe.each(OWNERS)('%s publishes the internal default a client can read', (name, locate) => {
  const owner = locate(publishedSchema(name));
  const published = prop(owner, 'public');

  it('advertises default: false machine-readably', () => {
    expect(published.default).toBe(false);
  });

  it('states in prose what omitting public does', () => {
    expect(published.description).toMatch(/omitted/i);
    expect(published.description).toMatch(/internal/i);
  });

  it('leaves public optional rather than required', () => {
    expect(owner.required ?? []).not.toContain('public');
  });
});
