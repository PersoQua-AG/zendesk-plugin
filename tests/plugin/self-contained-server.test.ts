import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../../src/server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'zd-plugin-copy-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// What an install receives: the tracked files, so node_modules/ and uncommitted build output are out.
function copyPluginPayload(dest: string): void {
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    mkdirSync(dirname(join(dest, file)), { recursive: true });
    cpSync(join(root, file), join(dest, file));
  }
}

// The entry the plugin really launches, with ${CLAUDE_PLUGIN_ROOT} resolved to the copy.
function pluginLaunchArgs(pluginRoot: string): { command: string; args: string[] } {
  const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const { command, args } = manifest.mcpServers.zendesk as { command: string; args: string[] };
  return { command, args: args.map((a) => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)) };
}

function dummyEnv(dataDir: string): Record<string, string> {
  return {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
    CLAUDE_PLUGIN_DATA: dataDir,
  };
}

async function inProcessToolNames(env: Record<string, string>): Promise<string[]> {
  const { server } = createServer(env);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'expected', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name).sort();
}

const pluginRoot = join(scratch, 'plugin');
copyPluginPayload(pluginRoot);
symlinkSync(pluginRoot, join(scratch, 'plugin-link'));

describe('plugin server from a copy without node_modules', () => {
  // A symlinked root is not resolved: Node realpaths the main module but argv[1] stays as given.
  it.each(['plugin', 'plugin-link'])('starts the entry plugin.json launches from %s and lists every tool over stdio', async (dir) => {
    const { command, args } = pluginLaunchArgs(join(scratch, dir));
    const transport = new StdioClientTransport({
      command: command === 'node' ? process.execPath : command,
      args,
      cwd: pluginRoot,
      env: dummyEnv(join(scratch, `data-${dir}`)),
    });
    const client = new Client({ name: 'plugin-copy', version: '0.0.0' });
    let names: string[];
    try {
      await client.connect(transport);
      names = (await client.listTools()).tools.map((t) => t.name).sort();
    } finally {
      await client.close();
    }

    const expected = await inProcessToolNames(dummyEnv(join(scratch, 'data-expected')));
    expect(expected.length).toBeGreaterThan(0);
    expect(names).toEqual(expected);
  }, 60_000);
});
