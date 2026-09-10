import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type ServerDeps } from '../../src/server.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixtureEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-login-reg-'));
  dirs.push(dataDir);
  return {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
    CLAUDE_PLUGIN_DATA: dataDir,
    ...overrides,
  };
}

async function listTools(env: NodeJS.ProcessEnv, deps?: ServerDeps) {
  const { server } = createServer(env, deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'login-reg', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe('zendesk_login registration', () => {
  it('is exposed on the stdio/extension path with an optional boolean force argument', async () => {
    const tools = await listTools(fixtureEnv());
    const login = tools.find((t) => t.name === 'zendesk_login');
    expect(login).toBeDefined();
    const schema = login?.inputSchema as { properties?: Record<string, { type?: string }>; required?: string[] };
    expect(schema.properties?.force?.type).toBe('boolean');
    expect(schema.required ?? []).not.toContain('force');
  });

  it('is NOT exposed on the remote bridge path, which has no localhost callback listener', async () => {
    const remoteDeps: ServerDeps = { authManager: { getAccessToken: vi.fn().mockResolvedValue('tok') } };
    const names = (await listTools(fixtureEnv(), remoteDeps)).map((t) => t.name);
    expect(names).not.toContain('zendesk_login');
  });

  it('leaves every pre-existing tool name untouched (purely additive)', async () => {
    const stdio = (await listTools(fixtureEnv())).map((t) => t.name);
    const remote = (
      await listTools(fixtureEnv(), { authManager: { getAccessToken: vi.fn().mockResolvedValue('tok') } })
    ).map((t) => t.name);
    expect(stdio.filter((n) => !remote.includes(n))).toEqual(['zendesk_login']);
  });
});
