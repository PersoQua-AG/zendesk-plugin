import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = join(root, 'scripts', 'assert-no-bound-port-literals.mjs');

// THIS FILE IS NOW INSIDE THE SCANNED TREE (#82). The root was tests/auth and the scan was one
// directory deep, so this file — in tests/plugin — could write its samples whole. The root is
// `tests` and the scan is recursive, so every sample literal here is a finding against the repo
// unless it is written split. It is split, through BIND below, and that cost is the honest price
// of scanning all 197 test files instead of 50. It was measured, not guessed: `npm run check:ports`
// against the widened root named 11 occurrences in this file and 1 in executor-safety-guard.test.ts.
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
// WRITTEN SPLIT, DELIBERATELY, AND SINCE #82 BOTH CONSTANTS ARE. A probe for a text guard cannot
// contain the text it probes for: written whole, ACQUIRES marks tests/plugin itself — the header's
// count becomes 2 of 27 instead of 1, which happened three times in #73 — and BIND makes this file
// a finding of the very check it tests. Neither is remembered: the counting command is executed
// below, and `npm run check:ports` over the whole test tree is the other half of the pin.
const ACQUIRES = `export function ${'freePort'}(): number { return 0; }\n`;

// Every sample bind call goes through this, including the two that only escaped the guard by
// accident: a sample written as a newline escape immediately followed by the call was never
// reported, because `\n` leaves an `n` in front of the call name and BIND_CALL needs a word
// boundary there. That is a property of an escape sequence,
// not a decision, and it would have broken the day a sample was written on a template line.
const BIND = (port: string) => `${'deps'}(${port})`;
const BOUND = BIND('18000');

// The script's marker, restated for the sweep below. Written whole it is still not a marker — the
// regex SOURCE reads `export (async )?function`, and the pattern wants `export ` then either
// `async ` or nothing then `function`, so `(async` matches neither branch and this file does not
// mark itself. If that ever stops being true the sweep's `expect(owners)` is red, and the counting
// command further down reaches the same answer by a different route (git + grep), so the two
// cross-check each other rather than both trusting this line.
const DEFINES_FREE_PORT = /\bexport (async )?function freePort\(/;

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

// THE SCAN ROOT IS READ OUT OF package.json, NEVER RETYPED (#82). Every case that claims something
// about the real gate takes its argument from here, so a case cannot agree with a wiring that no
// longer exists — the #82 defect was a wiring everyone believed covered the tests. The split
// asserts the shape too: one argument after the script, which is the #73 rule this widening had to
// keep. Anything else fails loudly here rather than scanning a tree nobody named.
function wiredRoot(): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const argv = String(pkg.scripts['check:ports']).split(/\s+/);
  expect(argv.slice(0, 2)).toEqual(['node', 'scripts/assert-no-bound-port-literals.mjs']);
  expect(argv).toHaveLength(3);
  return argv[2];
}

describe('the bound-port guard as a script', () => {
  it('refuses to run without a scan root, and refuses more roots than it scans', () => {
    const { status, stderr } = runGuard();
    expect(status).toBe(1);
    expect(stderr).toContain('Expected exactly one scan root');
    // A second root used to be dropped silently, so its literal was never looked for.
    const second = fixture({ 'p.ts': ACQUIRES + BOUND });
    expect(runGuard('tests/auth', second).status).toBe(1);
  });

  // Issue #73, scenario 2 — swept, not listed. The predecessor drove a fixed list of five wrong
  // roots. PR #71 turned two of them green (`tests`, `tests/tools`) and the list caught it — but
  // only because both happened to be on it. The merge also created `tests/server-remote` and
  // `tests/setup`, which were not; had the stray freePort() call landed in one of those, the list
  // would have stayed green. A list cannot know which directory the next merge will create. This
  // walks every directory in the repo that holds a tracked .ts file and demands that only the
  // ancestors of the allocator exit 0.
  //
  // WHAT #82 CHANGED HERE, and it is a weakening that has to be stated rather than absorbed: the
  // set used to be exactly one root, and it is three now — `.`, `tests` and `tests/auth`, the
  // directory that holds the definition plus every ancestor of it, because the mark follows the
  // recursive scan. It is still DERIVED and not listed: the expectation below is computed from
  // where the definition actually is, so moving login-harness.ts moves the expectation with it and
  // a second definition anywhere makes this red. The three are not interchangeable either — only
  // `tests` is wired, pinned separately below — and the two extra ones are both WIDER than the
  // wired root, which is the direction that cannot hide anything: `.` scans 275 .ts files to
  // tests' 197. Every root that is not an ancestor is refused in words, asserted here too, which
  // is where the narrow misedits (`tests/plugin`, `tests/tools`) land.
  // Cost, measured: 27 roots, 27 real `node` runs, 1.0s wall on this machine
  // (`time git ls-files '*.ts' | xargs -n1 dirname | sort -u | while read d; do \
  //   node scripts/assert-no-bound-port-literals.mjs "$d" >/dev/null 2>&1; done`).
  // That is affordable; if it stops being, the fallback is sampling, not a hand-kept list.
  it('reports success only for the allocator tree and its ancestors, and refuses every other', () => {
    const tracked = spawnSync('git', ['ls-files', '*.ts'], { cwd: root, encoding: 'utf8' });
    expect(tracked.status, tracked.stderr).toBe(0);
    const files = tracked.stdout.trim().split('\n');
    const roots = [...new Set(files.map((f) => dirname(f)))].sort();
    // A sweep that found nothing to sweep would pass every assertion below it.
    expect(roots.length).toBeGreaterThan(20);

    // Derived from disk: the directories that hold the definition, then their ancestor chains.
    const owners = [
      ...new Set(
        files
          .filter((f) => DEFINES_FREE_PORT.test(readFileSync(join(root, f), 'utf8')))
          .map((f) => dirname(f)),
      ),
    ];
    expect(owners).toEqual(['tests/auth']);
    const ancestors = new Set(
      owners.flatMap((d) =>
        d.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')).concat('.'),
      ),
    );
    expect([...ancestors].sort()).toEqual(['.', 'tests', 'tests/auth']);

    // THE SWEPT PROPERTY IS THE MARK, NOT THE EXIT CODE, and the difference is measured rather
    // than theoretical: with dependencies installed, `.` is a MARKED root that exits 1 anyway,
    // because node_modules is full of literals — 1909 .ts files, 1634 of them under node_modules,
    // and 21 findings in @types/node alone, all of them somebody else's documentation. (The
    // numbers are quoted and not the literals: this comment is inside the scanned tree now, and
    // a finding written into a comment here would be a true finding. See the file header.) An
    // exit-0 sweep would therefore have asserted `['tests', 'tests/auth']` locally with deps
    // present and `['.', 'tests', 'tests/auth']` without them — one tree, two answers by install
    // state, which is the same disqualifying shape #87 found in a case-folding `existsSync`.
    const marks = (d: string) => !runGuard(d).stderr.includes('Not the guarded tree');
    expect(roots.filter(marks).sort()).toEqual([...ancestors].sort());
    // Exit 0 is possible ONLY in a marked tree, and the wired root is one that actually reaches it.
    expect(roots.filter((d) => runGuard(d).status === 0).every(marks)).toBe(true);
    expect(runGuard(wiredRoot()).status).toBe(0);
    // The other side of the same cut: a non-ancestor is told it is the wrong tree, not merely
    // handed a non-zero exit. `tests/plugin` and `tests/tools` are in here by construction.
    for (const d of roots.filter((x) => !ancestors.has(x))) {
      expect(runGuard(d).stderr, d).toContain('Not the guarded tree');
    }
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
    // empty: that frame is the CommonJS spelling, and this guard is ESM with a named import, so
    // the string cannot occur whether or not readdirSync is guarded. Measured: with the try/catch
    // ablated the whole file still passed. This line is red against that ablation.
    expect(missing.stderr).toContain('Cannot scan');
  });

  it('names the file and the line of a literal port, and exits non-zero', () => {
    const dir = fixture({ 'probe.ts': `${ACQUIRES}\n\n${BOUND}` });
    const { status, stderr } = runGuard(dir);
    expect(status).toBe(1);
    expect(stderr).toContain(`${at(dir, 'probe.ts')}:4 ${BOUND}`);
  });

  // "Could not look" must not be spelled like "looked and found": both used to exit 1, and a
  // stack trace is not a message. A directory named `subdir.ts` is an entry readFileSync refuses.
  it('separates an unreadable file from a finding, by exit code', () => {
    const dir = fixture({ 'ok.ts': `${ACQUIRES}${BIND('port')};` });
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
    const dir = fixture({
      'p.ts': `${BIND('20_000')}; ${BIND('80')}; ${BIND('0')}\n${BIND('70_000')}\n${ACQUIRES}`,
    });
    const { stderr } = runGuard(dir);
    expect(stderr).toContain(`${at(dir, 'p.ts')}:1 ${BIND('20_000')}`);
    expect(stderr).toContain(`${at(dir, 'p.ts')}:1 ${BIND('80')}`);
    expect(stderr).not.toContain(BIND('0'));
    expect(stderr).not.toContain(BIND('70_000'));
  });

  // THE WIRED ROOT, NOT A ROOT THIS TEST CHOSE (#82). The argument comes out of package.json, so
  // this case cannot pass a tree the real gate does not scan — the mistake #82 exists to fix was
  // exactly a wiring that named less than everyone believed. The count is read off disk and
  // RECURSIVELY, which is the whole widening: non-recursive, `tests` holds 4 .ts files, and the
  // old `readdirSync` without the flag would have expected 4 where the guard now reports 197.
  it('passes the root package.json wires, and counts every .ts file beneath it', () => {
    const { status, stdout, stderr } = runGuard(wiredRoot());
    expect(status).toBe(0);
    expect(stderr).toBe('');
    const expected = readdirSync(join(root, wiredRoot()), { recursive: true }).filter((f) =>
      String(f).endsWith('.ts'),
    ).length;
    // A scan that lost half the tree must be red, and /\d+ files scanned/ would have been
    // satisfied by 1. The floor keeps a non-recursive regression from passing by agreeing with a
    // non-recursive expectation: measured on b9f0615, tests/ holds 197 tracked .ts files and 4
    // directly in it.
    expect(expected).toBeGreaterThan(100);
    expect(stdout).toContain(`Bound port literals in ${wiredRoot()}/: ${expected} files scanned.`);
    expect(stdout).toContain('Every bound port is acquired');
  });

  // #73 scenario 3 to the letter: a fixture directory containing a bound literal, named by file and
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
    const literal = { 'p.ts': `\n\n${BOUND}\n` };

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
  it('is wired to the whole test tree in package.json and run from CI', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['check:ports']).toBe(
      'node scripts/assert-no-bound-port-literals.mjs tests',
    );
    expect(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')).toContain(
      '- run: npm run check:ports',
    );
  });

  // login-harness.ts is where the harness binds and is not a *.test.ts, so a filter narrowed to
  // test files would silence the guard where it matters most.
  it('scans helper files too, not only *.test.ts', () => {
    const dir = fixture({ 'login-harness.ts': ACQUIRES + BOUND });
    expect(runGuard(dir).stderr).toContain(`login-harness.ts:2 ${BOUND}`);
  });

  // THE HEADER'S COUNT, EXECUTED. scripts/assert-no-bound-port-literals.mjs documents the command
  // that counts the directories carrying the marker and claims the answer is one. That claim was
  // wrong three times in this PR, every time because THIS file marked itself, and every time it
  // was caught by a human rather than by the suite. Run the documented command verbatim and the
  // next self-marking is red immediately. Measured cost: 1.0s — `xargs -n1 dirname` forks once per
  // tracked file. Worth it; shortening it would mean not running the documented command.
  it('runs the counting command from the script header and gets tests/auth, and nothing else', () => {
    // #82 changed the command with the scan: the old one asked each directory about the files
    // DIRECTLY in it (`"$d"/*.ts`), which cannot answer a recursive mark. This greps the tracked
    // files and then takes their directories, so it names where the definition IS rather than
    // which roots are marked — the roots are the ancestors of that, swept above.
    const COUNT = String.raw`git ls-files '*.ts' | xargs grep -lE '\bexport (async )?function freePort\(' \
      | xargs -n1 dirname | sort -u`;
    // The command is read out of the header, not retyped here: a header that drifts from the
    // command actually run would put the claim back on paper only.
    expect(readFileSync(GUARD, 'utf8')).toContain(
      String.raw`xargs grep -lE '\bexport (async )?function freePort\('`,
    );
    const run = spawnSync('sh', ['-c', COUNT], { cwd: root, encoding: 'utf8' });
    expect(run.stdout.trim().split('\n')).toEqual(['tests/auth']);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // #82: the widening itself. Every case below runs the guard over the REAL repository tree with
  // the REAL wired root, because the defect being fixed was invisible to any fixture: a temp tree
  // the test built was always scanned whole, so no fixture could show that 142 of 190 files in
  // THIS repository were not.
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  // The probe is a real file in a real subdirectory of the real scanned tree, removed in a finally
  // so a failed assertion cannot leave it behind. Not named *.test.ts on purpose: vitest must not
  // collect it, and the guard must still scan it — which is the "scans helper files too" rule.
  function withProbe<T>(relDir: string, source: string, body: () => T): T {
    const probe = join(root, relDir, 'zz-port-guard-probe.ts');
    writeFileSync(probe, source);
    try {
      return body();
    } finally {
      rmSync(probe, { force: true });
    }
  }

  // ACCEPTANCE CRITERION 1, with its control. Before #82 this file was simply not looked at:
  // measured on b9f0615, `npm run check:ports` with this exact probe in tests/tools printed
  // "Bound port literals in tests/auth/: 50 files scanned." and exited 0.
  it('fails and names file and line for a bound literal OUTSIDE tests/auth', () => {
    withProbe('tests/tools', `${ACQUIRES}\nexport const start = () => ${BOUND};\n`, () => {
      const run = runGuard(wiredRoot());
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`tests/tools/zz-port-guard-probe.ts:3 ${BOUND}`);
    });
  });

  it('passes the same file once the port is acquired instead of written', () => {
    withProbe(
      'tests/tools',
      `${ACQUIRES}\nexport const start = () => ${BIND('freePort()')};\n`,
      () => {
        const run = runGuard(wiredRoot());
        expect(run.stderr).toBe('');
        expect(run.status).toBe(0);
      },
    );
  });

  // The gap by directory, not by file: #68 and #80 added tests/tools and tests/plugin, and neither
  // was reachable from the old root. One probe per directory that holds tracked test sources, so a
  // future directory is covered the day it appears rather than the day someone remembers it.
  it('reaches every directory of the test tree, at every depth', () => {
    const tracked = spawnSync('git', ['ls-files', 'tests/**/*.ts', 'tests/*.ts'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(tracked.status, tracked.stderr).toBe(0);
    const dirs = [...new Set(tracked.stdout.trim().split('\n').map((f) => dirname(f)))].sort();
    expect(dirs.length).toBeGreaterThan(5);

    for (const dir of dirs) {
      withProbe(dir, `${ACQUIRES}${BOUND}\n`, () => {
        const run = runGuard(wiredRoot());
        expect(run.status, dir).toBe(1);
        expect(run.stderr, dir).toContain(`${dir}/zz-port-guard-probe.ts:2 ${BOUND}`);
      });
    }
  });

  // The empty string is a root only in the sense that resolve() accepts it, and recursion is what
  // made it dangerous: it walks the whole checkout including node_modules, and `.` IS a marked
  // root, so the run could exit 0 while its header line reads like a report about the tests.
  it('refuses the empty string instead of walking the repository root', () => {
    const run = runGuard('');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not the empty string');
    expect(run.stderr).not.toContain('node_modules');
    expect(run.stdout).toBe('');
  });
});
