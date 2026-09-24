import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type ServerDeps } from '../../src/server.js';

// A FILE as data dir makes mkdirSync throw ENOTDIR deterministically, no chmod, even as root.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function unwritableDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zd-degraded-cache-'));
  dirs.push(dir);
  const file = join(dir, 'not-a-directory');
  writeFileSync(file, '');
  return file;
}

function configuredEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
    CLAUDE_PLUGIN_DATA: dataDir,
  };
}

async function connect(env: NodeJS.ProcessEnv, deps: ServerDeps = {}) {
  const { server } = createServer(env, deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'degraded-cache', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

function textOf(result: unknown): string {
  return ((result as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n');
}

function expectCacheProblem(text: string, dataDir: string): void {
  expect(text).toContain('ENOTDIR');
  expect(text).toMatch(/data directory cannot be used/);
  expect(text).not.toContain(dataDir);
  expect(text).not.toMatch(/\bat .*\.(ts|js):\d+/);
}

describe('createServer with a data directory the cache cannot be created in', () => {
  it('still lists the full tool surface', async () => {
    const client = await connect(configuredEnv(unwritableDataDir()));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['zendesk_login', 'zendesk_get_me', 'zendesk_query']));
    await client.close();
  });

  it('answers zendesk_login with the cache problem', async () => {
    const dataDir = unwritableDataDir();
    const client = await connect(configuredEnv(dataDir));
    expectCacheProblem(textOf(await client.callTool({ name: 'zendesk_login', arguments: {} })), dataDir);
    await client.close();
  });

  it('answers a Zendesk tool with the cache problem, without fetching', async () => {
    const dataDir = unwritableDataDir();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const client = await connect(configuredEnv(dataDir), { fetchImpl });
    expectCacheProblem(textOf(await client.callTool({ name: 'zendesk_get_me', arguments: {} })), dataDir);
    expect(fetchImpl).not.toHaveBeenCalled();
    await client.close();
  });

  it('answers zendesk_query, which reads the cache without the network, with the cache problem', async () => {
    const dataDir = unwritableDataDir();
    const client = await connect(configuredEnv(dataDir));
    const result = await client.callTool({ name: 'zendesk_query', arguments: { cacheHandle: 'h-1', query: '.' } });
    expectCacheProblem(textOf(result), dataDir);
    await client.close();
  });

  it('holds the degrade even with an injected TokenProvider, without fetching', async () => {
    const dataDir = unwritableDataDir();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const authManager = { getAccessToken: vi.fn(async () => 'tok') };
    const client = await connect(configuredEnv(dataDir), { fetchImpl, authManager });
    expectCacheProblem(textOf(await client.callTool({ name: 'zendesk_get_me', arguments: {} })), dataDir);
    expect(fetchImpl).not.toHaveBeenCalled();
    await client.close();
  });

  it('names both problems when the configuration is incomplete as well', async () => {
    const dataDir = unwritableDataDir();
    const client = await connect({ ZENDESK_OAUTH_CLIENT_ID: 'client-abc', CLAUDE_PLUGIN_DATA: dataDir });
    const text = textOf(await client.callTool({ name: 'zendesk_get_me', arguments: {} }));
    expect(text).toContain('zendesk_subdomain');
    expectCacheProblem(text, dataDir);
    expect(text.match(/reload the extension/g)).toHaveLength(1);
    await client.close();
  });
});
