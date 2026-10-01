import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = join(root, 'scripts', 'assert-no-bound-port-literals.mjs');

// This file lives in tests/plugin, not in tests/auth, and its samples are written into temp
// directories. Neither is the tree the guard is pointed at, which is why the samples can say
// deps(18000) outright — the predecessor in tests/auth had to write 'deps' + '(18000)' to stay
// out of its own findings (#73).
const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Every fixture meant to BE a guarded tree carries its mark — one freePort() call — exactly as
// tests/auth does. A tree that never acquires a port is refused; see the script header.
const ACQUIRES = 'const port = freePort();\n';

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'port-guard-'));
  temps.push(dir);
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  return dir;
}

// Every case is a real run of the real script over a real directory on disk — never an assertion
// about a string in a file. The end-to-end composition the predecessor could not reach.
// `status` is raw: `status ?? -1` would turn "node never started" into a non-zero that satisfies
// every `not.toBe(0)` below, which is the #48 failure mode one level up.
function runGuard(...args: string[]) {
  const run = spawnSync('node', [GUARD, ...args], { encoding: 'utf8' });
  if (run.error) throw run.error;
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

// Findings are repo-relative, so a temp directory outside the repo is named by its way out of it.
const at = (dir: string, file: string) => relative(root, join(dir, file));

describe('the bound-port guard as a script', () => {
  it('refuses to run without a scan root, and refuses more roots than it scans', () => {
    const { status, stderr } = runGuard();
    expect(status).toBe(1);
    expect(stderr).toContain('Expected exactly one scan root');
    // A second root used to be dropped silently, so its literal was never looked for.
    const second = fixture({ 'p.ts': ACQUIRES + 'deps(18000)' });
    expect(runGuard('tests/auth', second).status).toBe(1);
  });

  // Issue #73, scenario 2. "Holds .ts files" is not the cut: `tests` holds four of them and would
  // have reported success while missing all 42 files of tests/auth below it.
  it('refuses every root that is not the tree it guards, instead of reporting it clean', () => {
    for (const wrong of ['tests', 'tests/util', 'tests/tools', 'tests/plugin', 'src/auth']) {
      const run = runGuard(wrong);
      expect(run.status, `${wrong} reported success:\n${run.stdout}`).not.toBe(0);
    }
    expect(runGuard('tests').stderr).toContain('no file directly in tests calls freePort()');
    // The empty and the vanished root are the same refusal, by the same rule.
    expect(runGuard(fixture({})).status).toBe(1);
    const missing = runGuard(join(fixture({}), 'gone'));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('ENOENT');
    expect(missing.stderr).not.toContain('at Object.readdirSync');
  });

  it('names the file and the line of a literal port, and exits non-zero', () => {
    const dir = fixture({ 'probe.ts': ACQUIRES + '\n\ndeps(18000)' });
    const { status, stderr } = runGuard(dir);
    expect(status).toBe(1);
    expect(stderr).toContain(`${at(dir, 'probe.ts')}:4 deps(18000)`);
  });

  // "Could not look" must not be spelled like "looked and found": both used to exit 1, and a
  // stack trace is not a message. A directory named `subdir.ts` is an entry readFileSync refuses.
  it('separates an unreadable file from a finding, by exit code', () => {
    const dir = fixture({ 'ok.ts': ACQUIRES + 'deps(port);' });
    mkdirSync(join(dir, 'subdir.ts'));
    const { status, stderr } = runGuard(dir);
    expect(status).toBe(2);
    expect(stderr).toContain('Cannot read');
    expect(stderr).not.toContain('at readFileSync');
  });

  // The rule itself, unchanged from the predecessor: port 0 is chosen by the OS and 70_000 is
  // refused by listen(), a separator must not hide a port, a privileged port is still fixed, and
  // two calls on one line are two findings.
  it('reads underscored and low literals and every call on a line, but not 0 or out of range', () => {
    const dir = fixture({ 'p.ts': 'deps(20_000); deps(80); deps(0)\ndeps(70_000)\n' + ACQUIRES });
    const { stderr } = runGuard(dir);
    expect(stderr).toContain(`${at(dir, 'p.ts')}:1 deps(20_000)`);
    expect(stderr).toContain(`${at(dir, 'p.ts')}:1 deps(80)`);
    expect(stderr).not.toContain('deps(0)');
    expect(stderr).not.toContain('deps(70_000)');
  });

  it('passes tests/auth, and says it looked at every .ts file in it', () => {
    const { status, stdout, stderr } = runGuard('tests/auth');
    expect(status).toBe(0);
    expect(stderr).toBe('');
    // Counted from disk, not pinned to a literal: a scan that lost half the tree must be red, and
    // /\d+ files scanned/ would have been satisfied by 1.
    const expected = readdirSync(join(root, 'tests', 'auth')).filter((f) => f.endsWith('.ts')).length;
    expect(stdout).toContain(`Bound port literals in tests/auth/: ${expected} files scanned.`);
    expect(stdout).toContain('Every bound port is acquired');
  });

  // The wiring IS the scan root now, so an unwitnessed edit there is the M3 mutation one level up.
  // The sibling guard is pinned the same way in executor-safety-guard.test.ts.
  it('is wired to tests/auth in package.json and run from CI', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['check:ports']).toBe(
      'node scripts/assert-no-bound-port-literals.mjs tests/auth',
    );
    expect(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')).toContain(
      '- run: npm run check:ports',
    );
  });

  // login-harness.ts is where the harness binds and is not a *.test.ts, so a filter narrowed to
  // test files would silence the guard where it matters most.
  it('scans helper files too, not only *.test.ts', () => {
    const dir = fixture({ 'login-harness.ts': ACQUIRES + 'deps(18000)' });
    expect(runGuard(dir).stderr).toContain('login-harness.ts:2 deps(18000)');
  });
});
