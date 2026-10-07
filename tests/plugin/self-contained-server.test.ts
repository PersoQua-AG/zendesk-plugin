import { describe, it, expect, afterAll, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { keychain } from '../auth/keychain.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Realpathed to keep this test to ONE subject: whether the bundle runs without node_modules. Until
// #63 this call was load-bearing — it steered around the entrypoint guard's symlink defect (macOS
// tmpdir is /var -> /private/var), and removing it turned this test red. That defect is fixed, so
// the call now only keeps blame where it belongs: tests/plugin/entrypoint-symlink.test.ts owns path
// spelling and creates its own link, which this cannot — tmpdir is a symlink on macOS but not on
// the ubuntu-latest CI runner, so leaning on it here would test nothing where it matters.
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

// A CHILD cannot be given the fake Keychain runner — it is a separate process running the shipped bundle —
// and for a while this test's child created the real `zendesk-plugin/token-store-key` on every run of the
// suite, which no source-parsing guard can see (tests/setup/no-real-keychain.ts now does).
//
// So it is spawned in the one state that needs no key at all: no subdomain, so resolveAuthConfig throws
// before the lazily-read key, and a ZENDESK_DATA_DIR that is a FILE, so the cache cannot be opened and
// the first-run setup gate is skipped too. The subject of this test is unaffected — whether the bundle the
// manifest launches runs at all, and whether it registers the same tools as this process — because the tool
// surface is registered whatever the configuration says. What the child can no longer prove, that the
// bundler kept the Keychain path, is asserted on the artifact in the case below.
function keylessEnv(dataDirAsFile: string): Record<string, string> {
  return { ZENDESK_DATA_DIR: dataDirAsFile };
}

function fileNotDirectory(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  return path;
}

async function inProcessToolNames(env: Record<string, string>): Promise<string[]> {
  const { server } = createServer(env, { security: keychain() });
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
      {
        cwd: pluginRoot,
        env: keylessEnv(fileNotDirectory(join(scratch, 'data-child'))),
        stdio: ['pipe', 'pipe', 'inherit'],
      },
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
    const expected = await inProcessToolNames(keylessEnv(fileNotDirectory(join(scratch, 'data-expected'))));
    expect(expected.length).toBeGreaterThan(0);
    expect(names).toEqual(expected);
  }, 60_000);

  // What the child used to prove by doing it, and now must not: that the bundler kept the Keychain path.
  // esbuild tree-shakes, node:child_process is reached from exactly one module, and a bundle that dropped
  // it would fail at the first login on a real machine rather than here.
  it('keeps the Keychain path in the bundle the manifest launches', () => {
    const bundle = readFileSync(join(root, 'dist', 'plugin', 'server.js'), 'utf8');
    expect(bundle).toContain('node:child_process');
    expect(bundle).toContain('/usr/bin/security');
    expect(bundle).toContain('find-generic-password');
    expect(bundle).toContain('add-generic-password');
    // And the stdin form, because an argv form would put the customer's client secret in `ps`.
    expect(bundle).toMatch(/"-U",\s*"-w"/);
  });
});
