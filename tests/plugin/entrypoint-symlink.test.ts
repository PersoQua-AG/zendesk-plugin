// tests/plugin/entrypoint-symlink.test.ts
// #63: one file under two names. Both shipped entry points are rowed, because
// .claude-plugin/plugin.json:14 launches the esbuild bundle and #63's citation of dist/server.js
// is stale; the bundle carries the same guard.
//
// SAFETY: the child's environment is BUILT, never spread, and HOME is never set. Overriding HOME
// does NOT sandbox the macOS Keychain — /usr/bin/security resolves its search list through $HOME
// as well, so a scratch HOME makes the real item invisible, the read returns 44, and the write
// path opens against a NULL keychain. That raised a system dialog on a developer's machine on
// 2026-10-07. ZENDESK_DATA_DIR points at a FILE so the cache and the setup gate stay out of the way.
//
// dist/ is tracked, so this file never builds or skips — and therefore pins the COMMITTED artifact;
// CI's `git diff --exit-code dist/` is what ties that artifact to src/. Named because #63 asks.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const ENTRIES = [
  ['the module entry point', ['dist', 'server.js']],
  ['the bundle .claude-plugin/plugin.json launches', ['dist', 'plugin', 'server.js']],
] as const;

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
  it.each(ENTRIES.flatMap(([what, parts]) => [
    [`${what} on the real path`, () => join(root, ...parts)],
    [`${what} through a symlinked plugin root`, () => join(linkedRoot, ...parts)],
  ]))('serves MCP over stdio through %s', async (_label, entry) => {
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

  // "Does not exist" is the only stat failure allowed to answer silently. ELOOP — measured: statSync
  // throws it even under { throwIfNoEntry: false } — stands in for EACCES and EIO, and #63 forbids
  // exactly their old outcome: exit 0, empty stderr, no transport. Rowed over both artifacts,
  // because dist/plugin/server.js carries its own copy of the guard.
  const loop = join(scratch, 'loop-a');
  symlinkSync(join(scratch, 'loop-b'), loop);
  symlinkSync(loop, join(scratch, 'loop-b'));

  it.each(ENTRIES)('fails loudly when argv[1] cannot be stat-ed at all, through %s', async (_what, parts) => {
    const entry = join(root, ...parts).replaceAll('\\', '/');
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `process.argv[1] = ${JSON.stringify(loop)}; await import(${JSON.stringify('file://' + entry)});`,
      ],
      { cwd: root, env: keylessEnv(), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).not.toBe(0);
    expect(stderr).toContain('ELOOP');
  }, 60_000);
});
