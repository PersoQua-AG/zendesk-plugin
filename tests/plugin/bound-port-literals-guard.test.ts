import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = join(root, 'scripts', 'assert-no-bound-port-literals.mjs');

// THIS FILE IS NOW INSIDE THE SCANNED TREE (#82), so every sample literal here would be a finding
// against the repo unless it is written split. It is, through ACQUIRES and BIND below.
const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// BOTH CONSTANTS ARE WRITTEN SPLIT, and that is the point of them. A probe for a text guard cannot
// contain the text it probes for: written whole, ACQUIRES marks tests/plugin as a guarded tree (it
// did, three times in #73) and BIND makes this file a finding of the very check it tests. A fixture
// meant to BE a guarded tree carries the DEFINITION of freePort(), as tests/auth/login-harness.ts
// does — a mere call is not the mark, because PR #71 put calls in three more directories at once.
const ACQUIRES = `export function ${'freePort'}(): number { return 0; }\n`;
const BIND = (port: string) => `${'deps'}(${port})`;
const BOUND = BIND('18000');

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

// MARKED IS WHAT THE RUN SAID, NOT WHAT IT FAILED TO SAY. The script puts its report line on
// stdout for a guarded tree and on stderr for every other, so the line's presence on stdout IS the
// mark. This used to be spelled `!stderr.includes('Not the guarded tree')`, and that reading
// counted every abort as a guarded tree: an exit-2 run prints neither notice. Pinned by the case
// 'does not count an aborted run as a marked tree' below, which the old spelling fails.
const isMarked = (run: { stdout: string }) => run.stdout.includes('Bound port literals in ');

// THE SCAN ROOT IS READ OUT OF package.json, NEVER RETYPED (#82). Every case that claims something
// about the real gate takes its argument from here, so a case cannot agree with a wiring that no
// longer exists — the #82 defect was a wiring everyone believed covered the tests. The exact
// command string is pinned separately below, so the shape is not asserted a second time here.
function wiredRoot(): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return String(pkg.scripts['check:ports']).split(/\s+/)[2];
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
  // marked set used to be exactly one root and is three now — `tests/auth`, which holds the
  // definition, plus its ancestors `tests` and `.`, because the mark follows the recursive scan.
  // The two extra ones are both WIDER than the wired root, the direction that cannot hide
  // anything, and they are not interchangeable with it: only `tests` is wired, pinned below.
  // Every root that is not an ancestor is refused in words, which is where the narrow misedits
  // (`tests/plugin`, `tests/tools`) land.
  it('reports success only for the allocator tree and its ancestors, and refuses every other', () => {
    const tracked = spawnSync('git', ['ls-files', '*.ts'], { cwd: root, encoding: 'utf8' });
    expect(tracked.status, tracked.stderr).toBe(0);
    const files = tracked.stdout.trim().split('\n');
    const roots = [...new Set(files.map((f) => dirname(f)))].sort();
    // A sweep that found nothing to sweep would pass every assertion below it.
    expect(roots.length).toBeGreaterThan(20);

    // WHERE THE DEFINITION IS is not re-derived here: the last case in this file runs the command
    // the script header documents and pins the answer to tests/auth, by git + grep rather than by
    // a second TypeScript walk over the same files. Moving login-harness.ts, or adding a second
    // definition, is red there — and then here, because this set stops matching the marked roots.
    const ancestors = new Set(['.', 'tests', 'tests/auth']);

    // THE SWEPT PROPERTY IS THE MARK, NOT THE EXIT CODE, and the difference is measured rather
    // than theoretical: with dependencies installed, `.` is a MARKED root that exits 1 anyway,
    // because node_modules is full of literals. Measured on c3ab1c1 plus this commit's directory
    // skip: `.` scans 4109 files (1910 of them .ts, 1634 .ts under node_modules) and exits 1 with
    // 27 findings — 19 in @types/node alone, all of them somebody else's documentation. (A count
    // of this repository's own tracked .ts files is a different number and is not needed here.)
    // Without the skip the same run ended at exit 2 on the directory `node_modules/ipaddr.js`
    // before printing anything, which is what made the old `marks` spelling look green.
    // An exit-0 sweep would therefore have asserted
    // `['tests', 'tests/auth']` locally with dependencies present and all three without them — one
    // tree, two answers by install state, the shape #87 found in a case-folding `existsSync`.
    //
    // ONE RUN PER ROOT, read three ways. Each root used to be spawned three or four times.
    const runs = new Map(roots.map((d) => [d, runGuard(d)]));
    const marks = (d: string) => isMarked(runs.get(d)!);
    expect(roots.filter(marks).sort()).toEqual([...ancestors].sort());
    // Exit 0 is possible ONLY in a marked tree, and the wired root is one that actually reaches it.
    expect(roots.filter((d) => runs.get(d)!.status === 0).every(marks)).toBe(true);
    expect(runGuard(wiredRoot()).status).toBe(0);
    // The other side of the same cut: a non-ancestor is told it is the wrong tree, not merely
    // handed a non-zero exit. `tests/plugin` and `tests/tools` are in here by construction.
    for (const d of roots.filter((x) => !ancestors.has(x))) {
      expect(runs.get(d)!.stderr, d).toContain('Not the guarded tree');
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
    // empty: `at Object.x` is the frame of a call through a module NAMESPACE object, not the
    // CommonJS spelling as first claimed, and every guard here imports named and calls direct, so
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
  // stack trace is not a message. The unreadable entry is a dangling symlink, not the directory
  // `subdir.ts` this case used to build: a directory is skipped now (see below), and a mode-000
  // file is readable again inside a CI container that runs as root.
  it('separates an unreadable file from a finding, by exit code', () => {
    const dir = fixture({ 'ok.ts': `${ACQUIRES}${BIND('port')};` });
    symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling.ts'));
    const { status, stderr } = runGuard(dir);
    expect(status).toBe(2);
    expect(stderr).toContain('Cannot read');
    // One rule, one spelling (#94): the same shape form its five siblings use since #77, rather
    // than `not.toContain('at readFileSync')`. The literal was reachable — ablating the catch to
    // print err.stack turned it red — but it only sees a leak whose frames happen to name that one
    // fs call; this path throws from readFileSync today and need not tomorrow. The shape catches
    // any node-internal frame, so it is strictly wider and costs nothing.
    expect(stderr).not.toMatch(/^\s+at .*\(node:/m);
  });

  // AN ABORT IS NOT A MARK. The sweep's predicate used to read the ABSENCE of 'Not the guarded
  // tree', and an exit-2 run prints neither notice — so every abort was counted as a guarded tree.
  // This fixture is unmarked (nothing defines freePort()) and aborts, which is the combination the
  // old spelling got wrong.
  it('does not count an aborted run as a marked tree', () => {
    const dir = fixture({ 'p.ts': `const p = ${BIND('freePort()')};\n` });
    symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling.ts'));
    const run = runGuard(dir);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    // The blind spot itself, stated: the sentence the old predicate looked for is absent here.
    expect(run.stderr).not.toContain('Not the guarded tree');
    expect(isMarked(run)).toBe(false);
  });

  // A DIRECTORY IS NOT AN UNREADABLE FILE. `node_modules/ipaddr.js` is a directory, and once the
  // filter took .js it matched: measured on c3ab1c1 at the repository root, the gate printed
  // `Cannot read node_modules/ipaddr.js: EISDIR.` and exited 2 with an empty stdout — before any
  // scan report, before any mark. A package named `anything.js` is ordinary; the gate must not
  // turn one into an infrastructure failure.
  it('skips a directory whose name ends in a source extension, and still scans into it', () => {
    const dir = fixture({ 'ok.ts': ACQUIRES });
    mkdirSync(join(dir, 'ipaddr.js'));
    writeFileSync(join(dir, 'ipaddr.js', 'index.ts'), `${BOUND}\n`);
    const run = runGuard(dir);
    expect(run.stderr).not.toContain('EISDIR');
    // Skipped, not stepped over: the walk is recursive, so the file INSIDE it is still a finding,
    // and the directory itself is not counted as a file somebody looked at.
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`${at(dir, join('ipaddr.js', 'index.ts'))}:1 ${BOUND}`);
    expect(run.stdout).toContain('2 files scanned.');
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
    // The same extension set the script filters on, not `.ts`: tests/ holds a .mjs since #87.
    const expected = readdirSync(join(root, wiredRoot()), { recursive: true }).filter((f) =>
      /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(String(f)),
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

  // EVERY SPELLING A TEST SOURCE CARRIES, not only .ts. The promise is "every test file", and
  // #87 put tests/plugin/executor-guard-property.mjs inside the scanned root where nothing looked
  // at it. The exit code is NOT the property here — a tree holding zero scanned files is unmarked
  // and exits 1 as well, which is exactly how the gap stayed invisible. What separates the two is
  // that the file is NAMED, and that its freePort() definition is read, so the tree is marked.
  // Measured against the `.ts`-only filter: .tsx, .mts, .cts, .js, .mjs and .cjs each named 0
  // findings before and 1 after.
  it('scans every test-source extension, not only .ts', () => {
    for (const ext of ['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs']) {
      const dir = fixture({ [`probe.${ext}`]: `${ACQUIRES}${BOUND}\n` });
      const run = runGuard(dir);
      expect(run.status, ext).toBe(1);
      expect(run.stderr, ext).toContain(`${at(dir, `probe.${ext}`)}:2 ${BOUND}`);
      expect(run.stderr, ext).not.toContain('Not the guarded tree');
      expect(run.stdout, ext).toContain('1 files scanned.');
    }
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
  // A `finally` does not cover a killed process, so an abort here leaves the probe on disk. How
  // loud that residue is depends on which probe it is, and only one of the two is caught by the
  // gate: the bound-literal probe makes `check:ports` go red, the `deps(freePort())` probe leaves
  // it green (measured: exit 0) and is shown by `git status` alone. Both are named for what they
  // are, which is what makes the quiet one survivable. No test file but this one runs the port
  // guard, so the window is this file's own, not a race with the rest of a parallel `vitest run`.
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
