// tests/plugin/entrypoint-symlink.test.ts
// #63: the stdio transport used to connect only when `import.meta.url === pathToFileURL(argv[1]).href`.
// Node resolves symlinks in an ES module's import.meta.url but leaves argv[1] as the host spelled it,
// so `node <symlink-to-plugin-root>/dist/server.js` loaded the module, connected nothing, and exited 0
// with an empty stderr. The launch command in .claude-plugin/plugin.json is exactly that shape.
//
// SAFETY: the child's environment is BUILT, never spread, and HOME is never set. Overriding HOME does
// NOT sandbox the macOS Keychain — /usr/bin/security resolves its search list through $HOME as well, so
// a scratch HOME makes the real item invisible, the read returns 44, and the write path opens against a
// NULL keychain (that is what raised a system dialog on a developer's machine on 2026-10-07). With HOME
// unset, security and os.homedir() both fall back to getpwuid and see the real, untouched keychain.
// ZENDESK_DATA_DIR points at a FILE so the cache cannot be opened and the first-run setup gate never
// runs; the entry point under test connects its transport before any of that matters.
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'zd-entrypoint-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A second name for the very same plugin root. Nothing is copied: the point is one file, two spellings.
const linkedRoot = join(scratch, 'linked-plugin-root');
symlinkSync(root, linkedRoot, 'dir');

function keylessEnv(name: string): Record<string, string> {
  const file = join(scratch, name);
  writeFileSync(file, '');
  return { ZENDESK_DATA_DIR: file };
}

// One initialize request over raw stdio; resolves with the first JSON line the child writes.
async function initializeThrough(entry: string, dataDir: string): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: keylessEnv(dataDir),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response from ${entry} within 20s`)), 20_000);
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      createInterface({ input: child.stdout }).on('line', (line) =>
        settle(() => resolve(JSON.parse(line) as Record<string, unknown>)),
      );
      child.on('error', (err) => settle(() => reject(err)));
      child.on('close', (code) => settle(() => reject(new Error(`exited ${code} without a response`))));
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'entrypoint-symlink', version: '0.0.0' },
          },
        }) + '\n',
      );
    });
  } finally {
    child.kill();
  }
}

describe('the server starts however its path is spelled', () => {
  it('has the built entry point on disk (dist/ is tracked)', () => {
    expect(existsSync(join(root, 'dist', 'server.js'))).toBe(true);
  });

  it.each([
    ['the real path', () => join(root, 'dist', 'server.js')],
    ['a symlinked plugin root', () => join(linkedRoot, 'dist', 'server.js')],
  ])('serves MCP over stdio through %s', async (label, entry) => {
    const message = await initializeThrough(entry(), `data-${label.replaceAll(' ', '-')}`);
    expect((message.result as { serverInfo: { name: string } }).serverInfo.name).toBe('zendesk');
  }, 60_000);

  // The other half of the guard: imported as a module it must still open no transport, or the suite
  // itself would block on stdin.
  it('opens no transport when the module is merely imported', async () => {
    const before = process.stdin.listenerCount('data');
    await import('../../src/server.js');
    expect(process.stdin.listenerCount('data')).toBe(before);
  });
});
