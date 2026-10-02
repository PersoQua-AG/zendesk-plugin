import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type ServerDeps } from '../../src/server.js';
import { RateLimiter } from '../../src/client/rate-limiter.js';
import { ResponseCache } from '../../src/client/cache.js';
import { keychain } from '../auth/keychain.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixtureEnv(): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-parity-'));
  dirs.push(dataDir);
  return {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
    CLAUDE_PLUGIN_DATA: dataDir,
  };
}

// Build a server the given way, list its tools over an in-memory transport pair.
async function listTools(env: NodeJS.ProcessEnv, deps?: ServerDeps) {
  const { server } = createServer(env, { security: keychain(), ...deps });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'parity', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools
    .map((t) => ({ name: t.name, inputSchema: t.inputSchema }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function remoteDeps(): ServerDeps {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-parity-remote-'));
  dirs.push(dataDir);
  return {
    authManager: { getAccessToken: vi.fn().mockResolvedValue('tok') },
    rateLimiter: new RateLimiter({ requestsPerMinute: 400 }),
    incrementalRateLimiter: new RateLimiter({ requestsPerMinute: 10 }),
    cache: new ResponseCache(join(dataDir, 'cache')),
  };
}

describe('tool-surface parity (remote vs stdio)', () => {
  // Parity holds for all 64 Zendesk tools. There are two deliberate exceptions, both local-only.
  // zendesk_login binds a LOCALHOST OAuth callback listener, which only the local (stdio / Desktop
  // Extension) path can receive — the remote bridge authorizes through its own public callback and
  // would offer a tool that can never complete. zendesk_diagnostics reports the machine the server
  // runs on, which on the remote path is the operator's and none of a remote user's business. Any
  // OTHER divergence is still a parity break.
  const LOCAL_ONLY = ['zendesk_login', 'zendesk_diagnostics'];

  it('exposes an identical set of 64 Zendesk tool names + input schemas on both transports', async () => {
    const env = fixtureEnv();
    const stdio = (await listTools(env)).filter((t) => !LOCAL_ONLY.includes(t.name));
    const remote = await listTools(fixtureEnv(), remoteDeps());

    expect(stdio).toHaveLength(64);
    expect(remote).toHaveLength(64);
    expect(remote.map((t) => t.name)).toEqual(stdio.map((t) => t.name));
    // Deep structural equality of every input JSON Schema (order-independent).
    expect(remote).toEqual(stdio);
  });

  it('zendesk_login and zendesk_diagnostics are the only tools the local path adds', async () => {
    const stdio = (await listTools(fixtureEnv())).map((t) => t.name);
    const remote = (await listTools(fixtureEnv(), remoteDeps())).map((t) => t.name);
    expect(stdio.filter((n) => !remote.includes(n)).sort()).toEqual([...LOCAL_ONLY].sort());
    expect(remote.filter((n) => !stdio.includes(n))).toEqual([]);
  });
});
