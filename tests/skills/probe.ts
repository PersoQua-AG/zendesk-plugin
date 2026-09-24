// tests/skills/probe.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { RateLimiter } from '../../src/client/rate-limiter.js';
import { ResponseCache } from '../../src/client/cache.js';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

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

// Fills EVERY property (optional ones too, booleans true) so a write tool really reaches its write.
export function sample(s: Schema, top: Schema = s): unknown {
  // The SDK emits a reused zod schema as a JSON pointer into the same inputSchema.
  if (s.$ref) return sample(s.$ref.split('/').slice(1).reduce((n, k) => (n as Record<string, Schema>)[k], top), top);
  if (s.enum) return s.enum[0];
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
    { ZENDESK_SUBDOMAIN: 'acme', ZENDESK_OAUTH_CLIENT_ID: 'client-abc', ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz', CLAUDE_PLUGIN_DATA: dataDir, ...env },
    {
      authManager: { getAccessToken: async () => 'tok' },
      rateLimiter: new RateLimiter({ requestsPerMinute: 400, sleep: async () => {} }),
      incrementalRateLimiter: new RateLimiter({ requestsPerMinute: 10, sleep: async () => {} }),
      cache: new ResponseCache(join(dataDir, 'cache')),
      fetchImpl,
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

// Methods each tool issues on one sampled call; a write behind a read that 200-{} fails is unseen.
export async function probeMethods(names: string[]): Promise<Record<string, string[]>> {
  const b = await boot();
  try {
    const schemas = await b.schemas();
    const out: Record<string, string[]> = {};
    for (const name of names) {
      const schema = schemas.get(name);
      if (!schema) throw new Error(`${name} is not a registered tool`);
      const before = b.calls.length;
      await b.call(name, sample(schema) as Record<string, unknown>);
      out[name] = b.calls.slice(before).map((c) => c.method);
    }
    return out;
  } finally {
    await b.close();
  }
}

export const writesIn = (methods: Record<string, string[]>): string[] =>
  Object.entries(methods).flatMap(([name, ms]) => ms.filter((m) => m !== 'GET').map((m) => `${name}: ${m}`));
