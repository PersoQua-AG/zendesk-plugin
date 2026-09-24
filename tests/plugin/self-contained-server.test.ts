// tests/plugin/self-contained-server.test.ts
// Claude Desktop installs the plugin as a copy of the repo without node_modules/ (#45). The server
// the plugin launches must start from exactly that copy and answer with its full tool surface.
import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../../src/server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// realpath: on macOS tmpdir() is behind the /var -> /private/var symlink.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'zd-plugin-copy-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// The repo as a git checkout sees it: tracked plus untracked-but-not-ignored, so node_modules/ is out.
function copyPluginPayload(dest: string): void {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
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

describe('plugin server from a copy without node_modules', () => {
  it('starts the entry plugin.json launches and lists every tool over stdio', async () => {
    const pluginRoot = join(scratch, 'plugin');
    copyPluginPayload(pluginRoot);
    const env = dummyEnv(join(scratch, 'data'));

    const { command, args } = pluginLaunchArgs(pluginRoot);
    const transport = new StdioClientTransport({
      command: command === 'node' ? process.execPath : command,
      args,
      cwd: pluginRoot,
      env: { PATH: process.env.PATH ?? '', ...env },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => (stderr += chunk));
    const client = new Client({ name: 'plugin-copy', version: '0.0.0' });
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`server did not start from the plugin copy: ${(error as Error).message}\n${stderr}`);
    }
    const { tools } = await client.listTools();
    await client.close();

    const expected = await inProcessToolNames(dummyEnv(join(scratch, 'data-expected')));
    expect(expected.length).toBeGreaterThan(0);
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
  }, 60_000);
});
