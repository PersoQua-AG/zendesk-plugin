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

// Every fixture meant to BE a guarded tree carries its mark — the DEFINITION of freePort(),
// exactly as tests/auth/login-harness.ts carries it. A mere call is no longer the mark: PR #71
// put freePort() calls in three more directories in a single merge and three wrong roots then
// exited 0. An unmarked tree is still scanned and its findings are still named, but it can never
// exit 0. See the script header.
//
// WRITTEN SPLIT, DELIBERATELY — the trick this very issue abolished for BIND_CALL. There it was
// avoidable: the probe could move out of the scanned tree, and it did, which is why the samples
// below say deps(18000) outright. Here it is not avoidable, because a probe for the marker must
// BY DEFINITION contain the marker. Written whole, this constant marks tests/plugin itself, and
// the header's count becomes 2 of 27 instead of 1 — which is exactly what happened and was caught
// in review. The pin below runs the documented counting command and fails if it ever happens
// again, so this split is enforced rather than remembered.
const ACQUIRES = `export function ${'freePort'}(): number { return 0; }\n`;

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

  // Issue #73, scenario 2 — swept, not listed. The predecessor drove a fixed list of five wrong
  // roots. PR #71 turned two of them green (`tests`, `tests/tools`) and the list caught it — but
  // only because both happened to be on it. The merge also created `tests/server-remote` and
  // `tests/setup`, which were not; had the stray freePort() call landed in one of those, the list
  // would have stayed green. A list cannot know which directory the next merge will create. This
  // walks every directory in the repo that holds a tracked .ts file and demands that exactly ONE
  // of them exits 0.
  // Cost, measured: 27 roots, 27 real `node` runs, 1.3s wall on this machine
  // (`time git ls-files '*.ts' | xargs -n1 dirname | sort -u | while read d; do \
  //   node scripts/assert-no-bound-port-literals.mjs "$d" >/dev/null 2>&1; done`).
  // That is affordable; if it stops being, the fallback is sampling, not a hand-kept list.
  it('reports success for exactly one root in the whole repo, and it is tests/auth', () => {
    const tracked = spawnSync('git', ['ls-files', '*.ts'], { cwd: root, encoding: 'utf8' });
    expect(tracked.status, tracked.stderr).toBe(0);
    const roots = [...new Set(tracked.stdout.trim().split('\n').map((f) => dirname(f)))].sort();
    // A sweep that found nothing to sweep would pass every assertion below it.
    expect(roots.length).toBeGreaterThan(20);

    const clean = roots.filter((d) => runGuard(d).status === 0);
    expect(clean).toEqual(['tests/auth']);
  });

  // The incident in one case: a foreign test file that merely CALLS freePort() lands in a wrong
  // tree. Under the old marker ("some file here calls freePort()") that tree reported success.
  it('is not marked by a tree that only calls freePort(), only by the one that defines it', () => {
    const caller = fixture({ 'foreign.test.ts': 'const p = freePort();\nawait listen(p);\n' });
    const run = runGuard(caller);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Not the guarded tree');
    expect(run.stdout).toBe('');
  });

  it('refuses a vanished or empty root, and says so without a stack trace', () => {
    expect(runGuard(fixture({})).status).toBe(1);
    const missing = runGuard(join(fixture({}), 'gone'));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('ENOENT');
    // Positive, not negative. `not.toContain('at Object.readdirSync')` was asserted here and was
    // empty: `at Object.x` is the frame of a call through a module NAMESPACE object, not the
    // CommonJS spelling as first claimed, and every guard here imports named and calls direct, so
    // the string cannot occur whether or not readdirSync is guarded. Measured: with the try/catch
    // ablated the whole file still passed. This line is red against that ablation.
    expect(missing.stderr).toContain('Cannot scan');
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

  // #73 scenario 3 to the letter: a fixture directory containing deps(18000), named by file and
  // line, exit non-zero — and the mark is not a precondition for getting that far. This case used
  // to assert the opposite (`not.toMatch(/p\.ts:3/)`), because the marker returned before the
  // scan; the marker now gates success only, so the scan always happens.
  //
  // The property the marker's benignity rested on — "a tree that fools the marker is still
  // SCANNED, so a deception costs more inspection, not less" — is no longer a property worth
  // pinning: every tree is scanned now, deceived or not, so the old contrast is structural. What
  // replaces it is the one thing that can still be lost: the unmarked tree must carry BOTH
  // notices. Findings alone would make a run aimed at the wrong tree look like an ordinary hit.
  it('names the literals of an unmarked tree, and says it is the wrong tree as well', () => {
    const literal = { 'p.ts': '\n\ndeps(18000)\n' };

    const bare = runGuard(fixture(literal));
    expect(bare.status).toBe(1);
    expect(bare.stderr).toMatch(/p\.ts:3 deps\(18000\)/);
    expect(bare.stderr).toContain('Not the guarded tree');
    // The streams are read apart, never merged: a run that ends in 1 leaves nothing on stdout
    // that reads like a report. The count line used to go to stdout unconditionally, so a wrong
    // tree left one there. spawnSync hands stdout and stderr back separately — no 2>&1.
    expect(bare.stdout).toBe('');

    // The contrast that remains: a marked tree reports the same finding WITHOUT the wrong-tree
    // notice, so the two runs are still told apart by their message, not only by their exit code.
    // The mark sits in a second file, as it does in tests/auth: login-harness.ts defines the
    // allocator, the files that bind live beside it.
    const pretending = runGuard(fixture({ ...literal, 'helper.ts': ACQUIRES }));
    expect(pretending.status).toBe(1);
    expect(pretending.stderr).toMatch(/p\.ts:3 deps\(18000\)/);
    expect(pretending.stderr).not.toContain('Not the guarded tree');
    // And the other side of the same cut: a guarded tree still reports its count on stdout, even
    // when it is refused for a finding. The line moves with the mark, not with the exit code.
    expect(pretending.stdout).toContain('files scanned.');
    expect(pretending.stderr).not.toContain('files scanned.');
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

  // THE HEADER'S COUNT, EXECUTED. scripts/assert-no-bound-port-literals.mjs documents the command
  // that counts the directories carrying the marker and claims the answer is one. That claim was
  // wrong three times in this PR, every time because THIS file marked itself, and every time it
  // was caught by a human rather than by the suite. Run the documented command verbatim and the
  // next self-marking is red immediately. Measured cost: 1.0s — `xargs -n1 dirname` forks once per
  // tracked file. Worth it; shortening it would mean not running the documented command.
  it('runs the counting command from the script header and gets tests/auth, and nothing else', () => {
    const COUNT = String.raw`git ls-files '*.ts' | xargs -n1 dirname | sort -u | while read d; do \
      grep -lE '\bexport (async )?function freePort\(' "$d"/*.ts >/dev/null 2>&1 && echo "$d"; done`;
    // The command is read out of the header, not retyped here: a header that drifts from the
    // command actually run would put the claim back on paper only.
    expect(readFileSync(GUARD, 'utf8')).toContain(
      String.raw`grep -lE '\bexport (async )?function freePort\(' "$d"/*.ts`,
    );
    const run = spawnSync('sh', ['-c', COUNT], { cwd: root, encoding: 'utf8' });
    expect(run.stdout.trim().split('\n')).toEqual(['tests/auth']);
  });
});
