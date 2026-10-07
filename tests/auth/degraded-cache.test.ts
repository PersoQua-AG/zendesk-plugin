import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type ServerDeps } from '../../src/server.js';
import { keychain } from './keychain.js';
import { modeBitsIgnored } from '../setup/mode-bits.js';

// A FILE as data dir makes mkdirSync throw ENOTDIR deterministically, no chmod, even as root.

const dirs: string[] = [];
const readOnly: string[] = [];
afterEach(() => {
  // Restore before rmSync, which cannot unlink inside a 0500 dir. Guarded so one failure
  // does not strand the rest of the cleanup.
  for (const d of readOnly.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* best effort */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function unwritableDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zd-degraded-cache-'));
  dirs.push(dir);
  const file = join(dir, 'not-a-directory');
  writeFileSync(file, '');
  return file;
}

// #54: a cache/ that EXISTS but is not writable. mkdir does not fail on it, so without the
// writability check the first save() throws EACCES with the absolute path into the tool result.
function readOnlyCacheDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zd-ro-cache-'));
  dirs.push(dir);
  const cache = join(dir, 'cache');
  mkdirSync(cache);
  chmodSync(cache, 0o500);
  readOnly.push(cache);
  return dir;
}

function configuredEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
    ZENDESK_DATA_DIR: dataDir,
  };
}

async function connect(env: NodeJS.ProcessEnv, deps: ServerDeps = {}) {
  const { server } = createServer(env, { security: keychain(), ...deps });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'degraded-cache', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

function textOf(result: unknown): string {
  return ((result as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n');
}

function expectCacheProblem(text: string, dataDir: string, code = 'ENOTDIR'): void {
  expect(text).toContain(code);
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
    const client = await connect({ ZENDESK_OAUTH_CLIENT_ID: 'client-abc', ZENDESK_DATA_DIR: dataDir });
    const text = textOf(await client.callTool({ name: 'zendesk_get_me', arguments: {} }));
    expect(text).toContain('zendesk_subdomain');
    expectCacheProblem(text, dataDir);
    expect(text.match(/reload the extension/g)).toHaveLength(1);
    await client.close();
  });
});

// chmod is not enforced for root, so the directory would stay writable and the test prove nothing.
describe.skipIf(modeBitsIgnored)('createServer with an existing read-only cache directory', () => {
  it('answers a caching tool with the errno code and no path', async () => {
    const dataDir = readOnlyCacheDataDir();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const client = await connect(configuredEnv(dataDir), { fetchImpl });
    expectCacheProblem(textOf(await client.callTool({ name: 'zendesk_get_me', arguments: {} })), dataDir, 'EACCES');
    expect(fetchImpl).not.toHaveBeenCalled();
    await client.close();
  });
});
