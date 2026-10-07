// tests/plugin/entrypoint-symlink.test.ts
// #63: started through a symlinked plugin root, the server loaded, connected NO transport and exited
// 0 with empty stderr — a plugin whose tools simply never appear, with nothing to diagnose. Node
// resolves symlinks in import.meta.url but leaves argv[1] as the caller typed it, so the entrypoint
// guard in src/server.ts compared a resolved path with an unresolved one and silently lost.
//
// The launch command is READ from .claude-plugin/plugin.json rather than written here: it moved from
// dist/server.js to dist/plugin/server.js in dc2ae3e, and a hard-wired path would have kept testing
// the artifact the plugin no longer starts.
//
// dist/ is read straight from the tree, as tests/plugin/self-contained-server.test.ts:104 already
// does. It is tracked (git ls-files dist -> 78 files), so it can only be STALE, never missing, and
// CI builds before it tests with `git diff --exit-code dist/` in between (ci.yml:40, :44, :49).
// Building here instead would spend esbuild seconds per run and let a test write the work tree the
// drift gate is guarding.
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both roots are realpathed, because the SPELLING of the path is the subject here: macOS tmpdir is
// itself a symlink (/var -> /private/var), so without this the direct row would secretly be a second
// symlink row on macOS and the link below would be the only honest case on Linux.
const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'zd-entrypoint-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// The link is the subject, so this test creates it rather than hoping the environment supplies one.
const link = join(scratch, 'plugin-link');
symlinkSync(root, link, 'dir');

const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
const { command, args } = manifest.mcpServers.zendesk as { command: string; args: string[] };

// A spawned child cannot be handed the fake Keychain, so it starts in the one state that needs no key
// at all: no subdomain, and a ZENDESK_DATA_DIR that is a FILE so no cache can be opened. Same reason
// and same shape as self-contained-server.test.ts:40-48 — without it the child writes a real Keychain
// item and tests/setup/no-real-keychain.ts fails the run.
function keylessEnv(name: string): Record<string, string> {
  const path = join(scratch, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  return { ZENDESK_DATA_DIR: path };
}

type Message = { id?: number; result?: { serverInfo?: { name?: string } } };

// Answers the initialize request, or rejects the row by timing out — the wait is bounded and
// event-driven (no sleep), so a server that connects no transport fails instead of hanging the suite.
async function initializeThrough(pluginRoot: string, dataDir: string): Promise<Message> {
  const child = spawn(
    command === 'node' ? process.execPath : command,
    args.map((a) => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)),
    { cwd: pluginRoot, env: keylessEnv(dataDir), stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const messages: Message[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)));
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'entrypoint-symlink', version: '0.0.0' } },
      }) + '\n',
    );
    await vi.waitFor(() => expect(messages.some((m) => m.id === 1)).toBe(true), { timeout: 20_000, interval: 50 });
  } finally {
    child.kill();
  }
  return messages.find((m) => m.id === 1)!;
}

describe('the server starts however its path is spelled', () => {
  it.each([
    ['the real path', () => root, 'data-direct'],
    ['a symlinked plugin root', () => link, 'data-symlink'],
  ])('serves MCP over stdio through %s', async (_spelling, pluginRoot, dataDir) => {
    const response = await initializeThrough(pluginRoot(), dataDir);
    expect(response.result?.serverInfo?.name).toBe('zendesk');
  }, 60_000);

  // The other half of the guard, and the reason it exists: imported rather than launched, the module
  // must connect nothing. A transport would put a 'data' listener on process.stdin and leave the
  // suite waiting on input that never comes. Nothing else in this FILE imports src/server.ts, so the
  // dynamic import below is the first one in this module registry and genuinely runs the guard.
  it('connects no transport when the module is merely imported', async () => {
    const before = process.stdin.listenerCount('data');
    await import('../../src/server.js');
    expect(process.stdin.listenerCount('data')).toBe(before);
  });
});
