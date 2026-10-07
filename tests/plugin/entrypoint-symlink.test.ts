// tests/plugin/entrypoint-symlink.test.ts
// #63: the stdio transport used to connect only when `import.meta.url === pathToFileURL(argv[1]).href`.
// Node resolves symlinks in an ES module's import.meta.url but leaves argv[1] as the host spelled it,
// so `node <symlink-to-plugin-root>/dist/server.js` loaded the module, connected nothing, and exited 0
// with an empty stderr. The launch command in .claude-plugin/plugin.json is exactly that shape. A
// case-differing spelling of the same path is the second shape of one file with two names, and on
// case-insensitive APFS it survived the realpath fix, so it is a row here too.
//
// SAFETY: the child's environment is BUILT, never spread, and HOME is never set. Overriding HOME does
// NOT sandbox the macOS Keychain — /usr/bin/security resolves its search list through $HOME as well, so
// a scratch HOME makes the real item invisible, the read returns 44, and the write path opens against a
// NULL keychain (that is what raised a system dialog on a developer's machine on 2026-10-07). With HOME
// unset, security and os.homedir() both fall back to getpwuid and see the real, untouched keychain.
// ZENDESK_DATA_DIR points at a FILE so the cache cannot be opened and the first-run setup gate never
// runs; the entry point under test connects its transport before any of that matters.
//
// dist/ is tracked, so the entry point is always on disk and this file never builds or skips. What it
// therefore pins is the COMMITTED artifact: `git diff --exit-code dist/` in CI is what ties that
// artifact to src/, and this file is green against a stale dist/ without it. Stated here because #63
// asks for the choice to be named.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

// A third spelling, available only where the filesystem folds case. On a case-sensitive volume
// `DIST/server.js` is a different, missing path, and the row is skipped rather than asserted wrongly.
const upperCased = join(root, 'DIST', 'server.js');
const caseFolds = ((): boolean => {
  try {
    return statSync(upperCased).isFile();
  } catch {
    return false;
  }
})();

let dataDirs = 0;
function keylessEnv(): Record<string, string> {
  const file = join(scratch, `data-${dataDirs++}`);
  writeFileSync(file, '');
  return { ZENDESK_DATA_DIR: file };
}

// One initialize request over raw stdio; resolves with the first JSON line the child writes. vitest's
// own per-case timeout ends a hang, so no second timer is kept here.
async function initializeThrough(entry: string): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: keylessEnv(),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    return await new Promise((resolve, reject) => {
      createInterface({ input: child.stdout }).on('line', (line) => resolve(JSON.parse(line) as Record<string, unknown>));
      child.on('error', reject);
      child.on('close', (code) => reject(new Error(`exited ${code} without a response`)));
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
  it.each([
    ['the real path', () => join(root, 'dist', 'server.js'), true],
    ['a symlinked plugin root', () => join(linkedRoot, 'dist', 'server.js'), true],
    ['a case-differing spelling', () => upperCased, caseFolds],
  ])('serves MCP over stdio through %s', async (_label, entry, applies) => {
    if (!applies) return; // case-sensitive volume: this spelling names no file at all
    const message = await initializeThrough(entry());
    expect((message.result as { serverInfo: { name: string } }).serverInfo.name).toBe('zendesk');
  }, 60_000);

  // The other half of the guard: imported as a module it must still open no transport, or the suite
  // itself would block on stdin. Asserted on the module registry rather than on a listener delta,
  // which another file's import of src/server.js would silently turn into a tautology.
  it('opens no transport when the module is merely imported', async () => {
    await import('../../src/server.js');
    expect(process.stdin.listenerCount('data')).toBe(0);
  });

  // The identity comparison is reached through argv[1], which statSync throws on when it names no
  // file. That throw answers "not the entrypoint", and none of the rows above exercises it: here
  // argv[1] is a path that does not exist while the module is reached by import, so the process must
  // open no transport and end on its own rather than waiting on stdin.
  it('treats an argv[1] that names no file as "not the entrypoint"', async () => {
    const entry = join(root, 'dist', 'server.js').replaceAll('\\', '/');
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', `process.argv[1] = '/nonexistent/not-a-file.js'; await import(${JSON.stringify('file://' + entry)});`],
      { cwd: root, env: keylessEnv(), stdio: ['pipe', 'pipe', 'inherit'] },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    expect(stdout).toBe('');
  }, 60_000);
});
