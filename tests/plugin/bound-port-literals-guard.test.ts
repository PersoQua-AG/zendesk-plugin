import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = join(root, 'scripts', 'assert-no-bound-port-literals.mjs');

// This file lives in tests/plugin, not in tests/auth, and its samples are written into temp
// directories. Both are outside every tree the guard is pointed at, which is why the samples can
// say deps(18000) outright — the predecessor in tests/auth had to write 'deps' + '(18000)' to stay
// out of its own findings (#73).
const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'port-guard-'));
  temps.push(dir);
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  return dir;
}

// Every case is a real run of the real script over a real directory on disk — never an assertion
// about a string in a file. The end-to-end composition the predecessor could not reach.
function runGuard(...args: string[]) {
  const run = spawnSync('node', [GUARD, ...args], { encoding: 'utf8' });
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

describe('the bound-port guard as a script', () => {
  it('refuses to run without a scan root and says what it expected', () => {
    const { status, stderr } = runGuard();
    expect(status).not.toBe(0);
    expect(stderr).toContain('Expected a scan root');
  });

  it('refuses a root that holds no test sources, instead of reporting it clean', () => {
    expect(runGuard(fixture({ 'notes.md': 'deps(18000)' })).status).not.toBe(0);
    expect(runGuard(fixture({})).stderr).toContain('not a test tree');
    const missing = runGuard(join(fixture({}), 'gone'));
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('ENOENT');
  });

  it('names the file and the line of a literal port, and exits non-zero', () => {
    const dir = fixture({ 'probe.ts': '\n\ndeps(18000)' });
    const { status, stderr } = runGuard(dir);
    expect(status).toBe(1);
    expect(stderr).toContain(`${join(dir, 'probe.ts')}:3 deps(18000)`);
  });

  // The rule itself, unchanged from the predecessor: port 0 is chosen by the OS and 70_000 is
  // refused by listen(), a separator must not hide a port, a privileged port is still fixed, and
  // two calls on one line are two findings.
  it('reads underscored and low literals and every call on a line, but not 0 or out of range', () => {
    const dir = fixture({ 'p.ts': 'deps(20_000); deps(80); deps(0)\ndeps(70_000)' });
    const { stderr } = runGuard(dir);
    expect(stderr).toContain(`${join(dir, 'p.ts')}:1 deps(20_000)`);
    expect(stderr).toContain(`${join(dir, 'p.ts')}:1 deps(80)`);
    expect(stderr).not.toContain('deps(0)');
    expect(stderr).not.toContain('deps(70_000)');
  });

  it('passes tests/auth, and says how many files that was', () => {
    const { status, stdout } = runGuard('tests/auth');
    expect(status).toBe(0);
    expect(stdout).toMatch(/Bound port literals in tests\/auth\/: \d+ files scanned\./);
    expect(stdout).toContain('Every bound port is acquired');
  });

  // login-harness.ts is where the harness binds and is not a *.test.ts, so a filter narrowed to
  // test files would silence the guard where it matters most.
  it('scans helper files too, not only *.test.ts', () => {
    const dir = fixture({ 'login-harness.ts': 'deps(18000)' });
    expect(runGuard(dir).stderr).toContain('login-harness.ts:1 deps(18000)');
  });
});
