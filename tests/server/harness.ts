import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';

const dirs: string[] = [];

export function cleanupDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export function fixtureEnv(): NodeJS.ProcessEnv {
  return {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
    CLAUDE_PLUGIN_DATA: tempDir('zd-prompts-'),
  };
}

export function unconfiguredEnv(): NodeJS.ProcessEnv {
  return { CLAUDE_PLUGIN_DATA: tempDir('zd-prompts-unconfigured-') };
}

export async function connect(env: NodeJS.ProcessEnv): Promise<Client> {
  const { server } = createServer(env);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'prompts', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

export function textOf(result: { messages: { content: { type: string; text?: string } }[] }): string {
  return result.messages.map((m) => m.content.text ?? '').join('\n');
}
