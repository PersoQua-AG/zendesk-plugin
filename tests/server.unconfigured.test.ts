import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A Desktop Extension host starts the server BEFORE the user has filled in the configuration
// dialog. Crashing there shows the user a dead extension with no explanation, so the server starts
// and every tool answers with the field to fill in instead.
function halfConfiguredEnv(): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-unconfigured-'));
  dirs.push(dataDir);
  return { ZENDESK_OAUTH_CLIENT_ID: 'client-abc', CLAUDE_PLUGIN_DATA: dataDir };
}

async function connect(env: NodeJS.ProcessEnv) {
  const { server } = createServer(env);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'unconfigured', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

function textOf(result: unknown): string {
  return ((result as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n');
}

describe('createServer with incomplete extension configuration', () => {
  it('starts instead of throwing', () => {
    expect(() => createServer(halfConfiguredEnv())).not.toThrow();
  });

  it('still registers the full tool surface so the host lists the extension normally', async () => {
    const client = await connect(halfConfiguredEnv());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('zendesk_login');
    await client.close();
  });

  it('answers a Zendesk tool call by naming the empty user_config field, without a stack trace', async () => {
    const client = await connect(halfConfiguredEnv());
    const result = await client.callTool({ name: 'zendesk_get_me', arguments: {} });
    const text = textOf(result);
    expect(text).toContain('zendesk_subdomain');
    expect(text).toMatch(/Settings/i);
    expect(text).not.toMatch(/\bat .*\.(ts|js):\d+/);
    await client.close();
  });

  it('answers zendesk_login with the same actionable message', async () => {
    const client = await connect(halfConfiguredEnv());
    const text = textOf(await client.callTool({ name: 'zendesk_login', arguments: {} }));
    expect(text).toContain('zendesk_subdomain');
    await client.close();
  });
});
