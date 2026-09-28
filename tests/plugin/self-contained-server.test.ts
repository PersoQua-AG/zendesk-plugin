import { describe, it, expect, afterAll, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Realpathed so the launch is not through a symlink (macOS tmpdir is /var -> /private/var).
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'zd-plugin-copy-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// What an install receives: the tracked files, so node_modules/ and uncommitted build output are out.
function copyPluginPayload(dest: string): void {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    mkdirSync(dirname(join(dest, file)), { recursive: true });
    cpSync(join(root, file), join(dest, file));
  }
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
  // Raw stdio, because the SDK Client silently drops a second response to the same id.
  it('starts the entry plugin.json launches and answers each request exactly once', async () => {
    const pluginRoot = join(scratch, 'plugin');
    copyPluginPayload(pluginRoot);
    const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    const { command, args } = manifest.mcpServers.zendesk as { command: string; args: string[] };
    const child = spawn(
      command === 'node' ? process.execPath : command,
      args.map((a) => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)),
      { cwd: pluginRoot, env: dummyEnv(join(scratch, 'data')), stdio: ['pipe', 'pipe', 'inherit'] },
    );
    const messages: { id?: number; result?: { tools: { name: string }[] } }[] = [];
    createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)));
    const send = (msg: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    try {
      send({
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plugin-copy', version: '0.0.0' } },
      });
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/list' });
      await vi.waitFor(() => expect(messages.some((m) => m.id === 2)).toBe(true), { timeout: 20_000, interval: 50 });
      await delay(500);
    } finally {
      child.kill();
    }

    expect(messages.filter((m) => m.id !== undefined).map((m) => m.id)).toEqual([1, 2]);
    const names = messages.find((m) => m.id === 2)!.result!.tools.map((t) => t.name).sort();
    const expected = await inProcessToolNames(dummyEnv(join(scratch, 'data-expected')));
    expect(expected.length).toBeGreaterThan(0);
    expect(names).toEqual(expected);
  }, 60_000);
});
