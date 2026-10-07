// tests/skills/probe.ts
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { RateLimiter } from '../../src/client/rate-limiter.js';
import { ResponseCache } from '../../src/client/cache.js';
import { keychain } from '../auth/keychain.js';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
export const filesIn = (dir: string, suffix: string): string[] =>
  readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith(suffix)).map((f) => join(dir, f)).sort();
// A skill is a skills/ folder with a SKILL.md, so stray files such as .DS_Store do not count.
export const skillNames = (): string[] => filesIn('skills', '/SKILL.md').map((f) => f.split('/')[1]);

// Same pattern claude-layer.test.ts uses to find tool references in skill/command/agent text.
export const toolsNamedIn = (text: string): string[] => [...new Set(text.match(/zendesk_[a-z0-9_]+/g) ?? [])].sort();

export interface Call {
  method: string;
  host: string;
  path: string;
  body?: string;
}

export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

type Schema = {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: unknown[];
  anyOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
  minimum?: number;
  pattern?: string;
};

// Fills EVERY property, booleans (draft, public, confirm, force) true on purpose so a write tool reaches its write.
export function sample(s: Schema, top: Schema = s): unknown {
  // The SDK emits a reused zod schema as a JSON pointer into the same inputSchema.
  if (s.$ref) return sample(s.$ref.split('/').slice(1).reduce((n, k) => (n as Record<string, Schema>)[k], top), top);
  // 'open' is a status every transition rule accepts, so the probe asserts no TM-8 rule either way.
  if (s.enum) return s.enum.includes('open') ? 'open' : s.enum[0];
  if (s.anyOf) return sample(s.anyOf[0], top);
  switch (s.type) {
    case 'integer':
    case 'number':
      return Math.max(1, s.minimum ?? 1);
    case 'boolean':
      return true;
    case 'array':
      return [sample(s.items ?? {}, top)];
    case 'object':
      return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sample(v, top)]));
    default:
      if (s.format === 'email') return 'customer@example.com';
      return ['x', 'en-us'].find((c) => !s.pattern || new RegExp(s.pattern).test(c)) ?? 'x';
  }
}

export interface Booted {
  calls: Call[];
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  schemas(): Promise<Map<string, Schema>>;
  close(): Promise<void>;
}

// The shipped stdio server; every outbound Zendesk request is recorded and answered, never sent.
export async function boot(reply: (c: Call, n: number) => Response = () => json({}), env: NodeJS.ProcessEnv = {}): Promise<Booted> {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-skills-'));
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const c: Call = { method: (init.method ?? 'GET').toUpperCase(), host: url.host, path: url.pathname };
    if (typeof init.body === 'string') c.body = init.body;
    calls.push(c);
    return reply(c, calls.length);
  }) as unknown as typeof fetch;
  const { server } = createServer(
    { ZENDESK_SUBDOMAIN: 'acme', ZENDESK_OAUTH_CLIENT_ID: 'client-abc', ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz', ZENDESK_DATA_DIR: dataDir, ...env },
    {
      authManager: { getAccessToken: async () => 'tok' },
      rateLimiter: new RateLimiter({ requestsPerMinute: 400, sleep: async () => {} }),
      incrementalRateLimiter: new RateLimiter({ requestsPerMinute: 10, sleep: async () => {} }),
      cache: new ResponseCache(join(dataDir, 'cache')),
      fetchImpl,
      security: keychain(),
    },
  );
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'skill-evals', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    calls,
    async call(name, args) {
      const res = (await client.callTool({ name, arguments: args })) as { content?: Array<{ text?: string }>; isError?: boolean };
      return { text: (res.content ?? []).map((c) => c.text ?? '').join('\n'), isError: res.isError === true };
    },
    async schemas() {
      const { tools } = await client.listTools();
      return new Map(tools.map((t) => [t.name, t.inputSchema as Schema]));
    },
    async close() {
      await client.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// One boot, one tool call, one close.
export async function once(name: string, args: Record<string, unknown>, reply?: (c: Call, n: number) => Response, env?: NodeJS.ProcessEnv) {
  const b = await boot(reply, env);
  try {
    return { ...(await b.call(name, args)), calls: b.calls };
  } finally {
    await b.close();
  }
}

// A macro preview answers in the shape the apply tool accepts, so its confirmed PUT is reached too.
// A ticket read answers WITH a status, because the lifecycle guard (#61) refuses a status change
// whose current status it could not read. Before that guard was fail-closed, this reply's empty `{}`
// was accepted as "not closed" and the probe reached the write by walking through the hole it is
// supposed to notice. 'open' is what sample() asks for, and every rule accepts it.
const probeReply = (c: Call): Response =>
  json(
    c.path.endsWith('/apply.json')
      ? { result: { ticket: {} } }
      : /\/tickets\/\d+\.json$/.test(c.path)
        ? { ticket: { id: 1, status: 'open' } }
        : c.path.includes('/tickets/show_many.json')
          ? { tickets: [{ id: 1, status: 'open' }] }
          : {},
  );

// "METHOD path" of every request each tool issues on one sampled call (default: every registered tool).
export async function probeRequests(names?: string[]): Promise<Record<string, string[]>> {
  const b = await boot(probeReply);
  try {
    const schemas = await b.schemas();
    const out: Record<string, string[]> = {};
    for (const name of names ?? [...schemas.keys()]) {
      const schema = schemas.get(name);
      if (!schema) throw new Error(`${name} is not a registered tool`);
      const before = b.calls.length;
      await b.call(name, sample(schema) as Record<string, unknown>);
      out[name] = b.calls.slice(before).map((c) => `${c.method} ${c.path}`);
    }
    return out;
  } finally {
    await b.close();
  }
}

// Every write the probe sees, pinned: a write tool it stops reaching, or a new one, turns the
// probe suite red. Also the static write-name authority for the skill pins (#62).
export const WRITES = [
  'zendesk_create_ticket: POST /api/v2/tickets.json',
  'zendesk_update_ticket: PUT /api/v2/tickets/1.json',
  'zendesk_add_comment: PUT /api/v2/tickets/1.json',
  'zendesk_add_ticket_tags: PUT /api/v2/tickets/1/tags.json',
  'zendesk_create_tickets_bulk: POST /api/v2/tickets/create_many.json',
  'zendesk_update_tickets_bulk: PUT /api/v2/tickets/update_many.json',
  'zendesk_upload_attachment: POST /api/v2/uploads.json',
  'zendesk_upsert_user: POST /api/v2/users/create_or_update.json',
  'zendesk_update_user: PUT /api/v2/users/1.json',
  'zendesk_upsert_org: POST /api/v2/organizations/create_or_update.json',
  'zendesk_update_org: PUT /api/v2/organizations/1.json',
  'zendesk_apply_macro_to_ticket: PUT /api/v2/tickets/1.json',
  'zendesk_create_trigger: POST /api/v2/triggers.json',
  'zendesk_update_trigger: PUT /api/v2/triggers/1.json',
  'zendesk_create_automation: POST /api/v2/automations.json',
  'zendesk_update_automation: PUT /api/v2/automations/1.json',
  'zendesk_create_sla: POST /api/v2/slas/policies.json',
  'zendesk_update_sla: PUT /api/v2/slas/policies/1.json',
  'zendesk_create_article: POST /api/v2/help_center/sections/1/articles.json',
  'zendesk_update_article: PUT /api/v2/help_center/articles/1.json',
  'zendesk_create_article_translation: POST /api/v2/help_center/articles/1/translations.json',
  'zendesk_update_article_translation: PUT /api/v2/help_center/articles/1/translations/en-us.json',
  'zendesk_create_section: POST /api/v2/help_center/categories/1/sections.json',
  'zendesk_create_category: POST /api/v2/help_center/categories.json',
];

export const writesIn = (requests: Record<string, string[]>): string[] =>
  Object.entries(requests).flatMap(([name, rs]) => rs.filter((r) => !r.startsWith('GET ')).map((r) => `${name}: ${r}`));

export interface RecordedCase {
  id: string;
  row: string;
  skill: string;
  role: 'happy' | 'failcheck';
  // recorded = instruction-following; the other two are findings kept as cases, not test targets.
  status: 'recorded' | 'unenforced' | 'pending-owner-decision';
  source: Array<{ file: string; line: number; quote: string }>;
  input: Record<string, unknown>;
  expected: string;
}

// Recorded cases for model behaviour: CI checks their structure and citations, never the behaviour.
export const recordedCases = (): Array<RecordedCase & { file: string }> =>
  filesIn('tests/skills/fixtures', '.json').map((file) => ({ ...(JSON.parse(read(file)) as RecordedCase), file }));
