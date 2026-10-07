import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = join(root, 'scripts', 'assert-executor-safety.mjs');

const temps: string[] = [];
const mutants: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of mutants.splice(0)) rmSync(f, { force: true });
});

type Run = { status: number; stdout: string; stderr: string };

// Every fixture meant to BE a guarded tree carries its mark — a server.ts directly in the scanned
// root, exactly as src/ carries the module the build bundles. An unmarked tree is still scanned and
// its findings are still named, but it can never exit 0. See the script header.
function fixtureDir(source: string, fileName: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'executor-guard-'));
  temps.push(dir);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', fileName), source);
  writeFileSync(join(dir, 'src', 'server.ts'), MARK);
  return join(dir, 'src');
}

// The four things that marked a tree while the mark was a mere existsSync() — none of them a
// regular server.ts collected by the walk. Shared by the behaviour test and its ablation.
const MARK = '// marks this tree as the one the build bundles\n';
const MIS_MARKS = {
  'a directory': (dir: string) => mkdirSync(join(dir, 'server.ts')),
  'the wrong case': (dir: string) => writeFileSync(join(dir, 'Server.ts'), MARK),
  'a symlink out of the tree': (dir: string) => {
    const outside = mkdtempSync(join(tmpdir(), 'executor-guard-outside-'));
    temps.push(outside);
    writeFileSync(join(outside, 'server.ts'), MARK);
    symlinkSync(join(outside, 'server.ts'), join(dir, 'server.ts'));
  },
  'a dangling symlink': (dir: string) => symlinkSync(join(dir, 'nope.ts'), join(dir, 'server.ts')),
};

function misMarked(build: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'executor-guard-'));
  temps.push(dir);
  writeFileSync(join(dir, 'subject.ts'), 'export const x = 1;\n');
  build(dir);
  return dir;
}

// Every case below is a real run of the real script over a real tree on disk — the directory to
// inspect is argv[2] — not an assertion about a string in a file. With no source it runs over the
// repo's own src/, which is the tree package.json points it at; there is no default any more.
function runGuard(source?: string, fileName = 'subject.ts'): Run {
  const target = source === undefined ? 'src' : fixtureDir(source, fileName);
  const run = spawnSync('node', [GUARD, target], { encoding: 'utf8' });
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

// A mutant is the guard with one rule ablated. It has to live beside the real one so that its
// `import ts from 'typescript'` resolves against the repo's node_modules.
function mutate(edits: Array<[string, string]>): string {
  let code = readFileSync(GUARD, 'utf8');
  for (const [find, replace] of edits) {
    expect(code, `mutation anchor missing: ${find.slice(0, 60)}`).toContain(find);
    code = code.replace(find, replace);
  }
  const path = join(root, 'scripts', `.mutant-${Math.random().toString(36).slice(2)}.mjs`);
  mutants.push(path);
  writeFileSync(path, code);
  return path;
}

function runMutant(edits: Array<[string, string]>, source: string, fileName = 'subject.ts'): Run {
  const run = spawnSync('node', [mutate(edits), fixtureDir(source, fileName)], {
    encoding: 'utf8',
  });
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

// w1 — the exact #9 shape: a call that throws synchronously, on the synchronous path of an executor
// nested inside another one, with the inner rejection swallowed by `.catch(() => {})`.
const WEDGE = `
export function startListener(port: number, server: { listen: (p: number) => void }) {
  return new Promise<void>((bound, bindFailed) => {
    const promise = new Promise<string>((resolve, reject) => {
      server.listen(port);
      bound();
    });
    promise.catch(() => {});
  });
}
`;

// An async TOP-LEVEL executor: no nesting, and its synchronous throw still lands in the async
// function's discarded return promise instead of the one the caller awaits.
const ASYNC_WEDGE = `
export const start = (port: number, server: { listen: (p: number) => void }) =>
  new Promise<void>(async (bound, bindFailed) => {
    server.listen(port);
    bound();
  });
`;

// Catch bodies in these fixtures are deliberately CALL-FREE. A `new Error('x')` or a `Math.random()`
// in a catch is itself an unguarded call and would produce exit=1 on its own, which is how three
// earlier versions of this file passed while pinning nothing.
const bareThrow = (wedge: string) =>
  wedge.replace('server.listen(port);', 'try { server.listen(port); } catch (e) { throw e; }');
const outerSettle = (wedge: string, name: string) =>
  wedge.replace(
    'server.listen(port);',
    `try { server.listen(port); } catch (e) { ${name}(e as Error); }`,
  );

// The settle exemption, in both directions. Inside a settling catch the whole expression is
// exempt; on the ordinary path only the settle CALL is not foreign — its arguments are still walked.
const SETTLE_IN_CATCH = WEDGE.replace(
  'server.listen(port);',
  'try { server.listen(port); } catch (e) { bindFailed(e instanceof Error ? e : new Error(String(e))); }',
);
const SETTLE_ARG_ON_HAPPY_PATH = `
export const f = (load: () => string) =>
  new Promise<void>((bound, bindFailed) => {
    const inner = new Promise<void>(() => {
      bindFailed(new Error(load()));
    });
    inner.catch(() => {});
    bound();
  });
`;

describe('promise executor safety guard', () => {
  describe('w1 — the defect class it exists for', () => {
    it('flags an unguarded call on a nested executor path, with file:line and the call', () => {
      const { status, stderr } = runGuard(WEDGE);
      expect(status).toBe(1);
      expect(stderr).toMatch(/subject\.ts:5:\d+\s+server\.listen\(port\)/);
      expect(stderr).toContain('rejects only the INNER promise');
      // The remedy names the enclosing executor's own reject parameter, read from the AST.
      expect(stderr).toContain('bindFailed(err)');
    });

    it('offers moving the call out to the top level as the preferred remedy', () => {
      // That is what actually fixed #9. A guard that only ever proposes wrapping steers its own
      // repository towards the weaker of the two fixes.
      expect(runGuard(WEDGE).stderr).toContain('PREFER moving the call out');
    });

    it('still flags it when the parameters carry the idiomatic shadowing names', () => {
      // With `resolve, reject` on BOTH executors the inner reject is name-identical to the outer
      // one, and a name-based settler set credits it with settling a promise it cannot reach.
      const shadowed = WEDGE.replace('(bound, bindFailed)', '(resolve, reject)').replace(
        'bound();',
        'resolve();',
      );
      expect(runGuard(shadowed).status).toBe(1);
      const run = runGuard(outerSettle(shadowed, 'reject'));
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/server\.listen\(port\)/);
    });

    it('is not satisfied by a bare throw — that rejects the inner promise, which is the bug', () => {
      const { status, stderr } = runGuard(bareThrow(WEDGE));
      expect(status).toBe(1);
      // The status alone would not pin this: it must be the guarded call that is reported.
      expect(stderr).toMatch(/server\.listen\(port\)/);
    });

    it('does not accept a foreign call sitting in the catch block itself', () => {
      const { status, stderr } = runGuard(
        WEDGE.replace(
          'server.listen(port);',
          'try { bindFailed(new Error("x")); } catch (e) { server.listen(port); bindFailed(e as Error); }',
        ),
      );
      expect(status).toBe(1);
      expect(stderr).toMatch(/server\.listen\(port\)/);
    });

    it('passes a nested call guarded by a catch that settles the OUTER executor', () => {
      const { status, stdout } = runGuard(outerSettle(WEDGE, 'bindFailed'));
      expect(status).toBe(0);
      expect(stdout).toContain('nested, inspected');
    });

    it('exempts the settle expression as a whole inside a settling catch', () => {
      // Otherwise the honest `reject(err instanceof Error ? err : new Error(String(err)))` is
      // reported and the code bends to the tool — which is how a type lie got into src/.
      expect(runGuard(SETTLE_IN_CATCH).status).toBe(0);
    });

    it('still walks the arguments of a settle call outside a catch', () => {
      // The exemption is a catch exemption, and only the catch case justifies it. Here `load()`
      // throws synchronously, nothing settles the outer promise, and the wedge is back — so the
      // argument must still be reported.
      const { status, stderr } = runGuard(SETTLE_ARG_ON_HAPPY_PATH);
      expect(status).toBe(1);
      expect(stderr).toContain('load()');
    });

    it('passes the call moved out to a sync top level — a throw there rejects the right promise', () => {
      expect(
        runGuard(`
export function startListener(port: number, server: { listen: (p: number) => void }) {
  return new Promise<void>((bound, bindFailed) => {
    const promise = new Promise<string>((resolve) => { bound(); });
    promise.catch(() => {});
    server.listen(port);
  });
}
`).status,
      ).toBe(0);
    });
  });

  describe('w1b — async executors', () => {
    it('inspects an async TOP-LEVEL executor and flags the unguarded call', () => {
      const { status, stderr, stdout } = runGuard(ASYNC_WEDGE);
      expect(status).toBe(1);
      expect(stderr).toMatch(/server\.listen\(port\)/);
      expect(stdout).toMatch(/async, inspected/);
    });

    it('does not advise moving the call out — an async executor has nowhere to move it to', () => {
      const { stderr } = runGuard(ASYNC_WEDGE);
      expect(stderr).not.toContain('PREFER moving the call out');
      expect(stderr).toContain('an async executor IS the top level');
      // The nested case keeps the advice that actually fixed #9.
      expect(runGuard(WEDGE).stderr).toContain('PREFER moving the call out');
    });

    it('accepts the async executor once its own reject settles the promise', () => {
      expect(runGuard(outerSettle(ASYNC_WEDGE, 'bindFailed')).status).toBe(0);
    });

    it('is not satisfied by a bare throw in an async executor either', () => {
      const { status, stderr } = runGuard(bareThrow(ASYNC_WEDGE));
      expect(status).toBe(1);
      expect(stderr).toMatch(/server\.listen\(port\)/);
    });
  });

  describe('w2 — the executor reached through a variable', () => {
    it('follows an identifier to its arrow function', () => {
      const { status, stderr } = runGuard(`
const exec = (resolve: (v: void) => void, reject: (e: Error) => void) => {
  (globalThis as unknown as { boom: () => void }).boom();
  resolve();
};
export const f = () =>
  new Promise<void>((bound, bindFailed) => {
    const inner = new Promise<void>(exec);
    inner.catch(() => {});
    bound();
  });
`);
      expect(status).toBe(1);
      expect(stderr).toMatch(/subject\.ts:3:\d+/);
    });

    it('follows an identifier to a function declaration', () => {
      expect(
        runGuard(`
function exec(resolve: (v: void) => void) {
  (globalThis as unknown as { boom: () => void }).boom();
  resolve();
}
export const f = () =>
  new Promise<void>((bound) => {
    const inner = new Promise<void>(exec);
    inner.catch(() => {});
    bound();
  });
`).status,
      ).toBe(1);
    });
  });

  describe('w4/w5 — bindings, not names', () => {
    it('does not exempt a locally declared function that shares a global name', () => {
      // `createServer` once sat on an allowlist keyed by NAME; a local one inherited the pass.
      const { status, stderr } = runGuard(`
function createServer(_h: () => void) { return { listen: (_p: number) => {} }; }
export const f = () =>
  new Promise<void>((bound, bindFailed) => {
    const inner = new Promise<void>((resolve) => {
      createServer(() => {});
      resolve();
    });
    inner.catch(() => {});
    bound();
  });
`);
      expect(status).toBe(1);
      expect(stderr).toMatch(/createServer/);
    });

    it('does not treat a method call as settling just because it is named resolve', () => {
      // The status cannot pin this — `router.resolve('/x')` sits in the catch and is itself an
      // unguarded call, so exit=1 either way. What discriminates is whether the TRY block was
      // credited as safe: if it was, `boom()` goes unreported.
      const { stderr } = runGuard(`
export const f = (router: { resolve: (p: string) => string }) =>
  new Promise<void>((resolve, reject) => {
    const inner = new Promise<void>((res) => {
      try {
        (globalThis as unknown as { boom: () => void }).boom();
      } catch {
        router.resolve('/x');
      }
      res();
    });
    inner.catch(() => {});
    resolve();
  });
`);
      expect(stderr).toMatch(/\.boom\(\)/);
    });
  });

  describe('w7 — the catch must settle unconditionally', () => {
    it('rejects a settle that hides behind a condition', () => {
      const { status, stderr } = runGuard(
        WEDGE.replace(
          'server.listen(port);',
          // The condition is deliberately call-free: the ONLY thing separating this from the
          // accepted form is that the settle is conditional.
          'try { server.listen(port); } catch (e) { if (port > 0) bindFailed(e as Error); }',
        ),
      );
      expect(status).toBe(1);
      expect(stderr).toMatch(/server\.listen\(port\)/);
    });
  });

  describe('w8 — one finding per chained expression', () => {
    it('reports a call chain once, not once per link', () => {
      const { stderr, status } = runGuard(`
export const f = (items: string[]) =>
  new Promise<void>((bound, bindFailed) => {
    const inner = new Promise<void>((resolve) => {
      const s = items.map((i) => i).filter((i) => i.length > 0).join(',');
      resolve();
    });
    inner.catch(() => {});
    bound();
  });
`);
      expect(status).toBe(1);
      expect(stderr.match(/subject\.ts:\d+:\d+/g)).toHaveLength(1);
      expect(stderr).toContain('.join(');
    });
  });

  describe('w9 — the remediation hint must not propose a second defect', () => {
    it('does not tell the author to resolve the outer promise with an Error', () => {
      const { status, stderr } = runGuard(`
export const f = (port: number, server: { listen: (p: number) => void }) =>
  new Promise<void>((bound) => {
    const inner = new Promise<void>((resolve) => {
      server.listen(port);
      resolve();
    });
    inner.catch(() => {});
  });
`);
      expect(status).toBe(1);
      expect(stderr).not.toMatch(/bound\(err\)/);
      expect(stderr).toContain('declares no reject parameter');
    });
  });

  // These are LIMITS, pinned as limits: the guard is silent here and the header says so. Without a
  // test they drift from documented to forgotten at the next rewrite.
  describe('documented limits', () => {
    it('is silent on a throw inside a .then callback — the last silent-wedge form', () => {
      // Measured: the outer promise never settles and nothing crashes. Same class as #9, and this
      // synchronous walk cannot see it. Not live in src/ — job-poller.ts:15 and rate-limiter.ts:19
      // hand `resolve` straight to setTimeout and contain no throwing call.
      expect(
        runGuard(`
export const f = () =>
  new Promise<void>((bound) => {
    Promise.resolve().then(() => {
      (globalThis as unknown as { boom: () => void }).boom();
      bound();
    });
  });
`).status,
      ).toBe(0);
    });

    it('is silent on a Promise aliased through a variable', () => {
      expect(
        runGuard(`
const P = Promise;
export const f = (server: { listen: (p: number) => void }, port: number) =>
  new P((bound: (v: void) => void) => {
    const inner = new P((resolve: (v: void) => void) => { server.listen(port); resolve(); });
    (inner as Promise<void>).catch(() => {});
    bound();
  });
`).status,
      ).toBe(0);
    });

    it('reports a missing target as a message, not as an ENOENT stack trace', () => {
      const run = spawnSync('node', [GUARD, join(root, 'no-such-directory')], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('Nothing to inspect');
      expect(run.stderr).not.toMatch(/^\s+at .*\(node:/m);
    });
  });

  describe('file collection', () => {
    it('inspects .tsx, .mts and .cts, and skips declaration files', () => {
      for (const name of ['subject.tsx', 'subject.mts', 'subject.cts']) {
        expect(runGuard(WEDGE, name).status, name).toBe(1);
      }
      expect(runGuard(WEDGE, 'subject.d.ts').status).toBe(0);
    });
  });

  describe('the scan root the caller names', () => {
    it('refuses to run without a scan root, and refuses more roots than it scans', () => {
      const bare = spawnSync('node', [GUARD], { encoding: 'utf8' });
      expect(bare.status).toBe(1);
      expect(bare.stderr).toContain('Expected exactly one scan root');
      // A second root would be dropped silently, so its executors would never be looked at.
      const second = fixtureDir(WEDGE, 'subject.ts');
      const two = spawnSync('node', [GUARD, 'src', second], { encoding: 'utf8' });
      expect(two.status).toBe(1);
      expect(two.stderr).toContain('Expected exactly one scan root');
    });

    // The defect this ticket exists for: before the mark, `tests/util` printed "0 executors,
    // 0 inspected" and exited 0, so an empty tree was indistinguishable from a clean one.
    it('refuses a tree that is not the one the build bundles, however clean it is', () => {
      const run = spawnSync('node', [GUARD, 'tests/util'], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('Not the guarded tree');
      expect(run.stdout).not.toContain('Promise executors in');
    });

    // The mark gates success, not the scan: an unmarked tree is still walked whole, and a wedge in
    // it is still named by file and line — alongside the notice that the root is wrong.
    it('still names every finding in an unmarked tree, and says the root is wrong too', () => {
      const dir = mkdtempSync(join(tmpdir(), 'executor-guard-'));
      temps.push(dir);
      writeFileSync(join(dir, 'subject.ts'), WEDGE);
      const run = spawnSync('node', [GUARD, dir], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/subject\.ts:\d+:\d+\s+server\.listen\(port\)/);
      expect(run.stderr).toContain('Not the guarded tree');
    });

    // The mark is a FILE THE WALK COLLECTED. Each of these marked the tree while the check was
    // `existsSync(join(target, ENTRY))`, and none of them is the module the build bundles. The
    // wrong case matters most: existsSync case-folds on darwin, so that tree was green here and
    // red on Linux CI. The dangling symlink was already refused and must stay refused.
    it('is not marked by a directory, the wrong case, or a symlink called server.ts', () => {
      for (const [what, build] of Object.entries(MIS_MARKS)) {
        const run = spawnSync('node', [GUARD, misMarked(build)], { encoding: 'utf8' });
        expect(run.status, what).toBe(1);
        expect(run.stderr, what).toContain('Not the guarded tree');
      }
    });

    // The stream is keyed on the MARK, not on the exit code — which is what the script now says,
    // instead of promising an empty stdout for every red run. The inventory of the guarded tree is
    // a true record of what was inspected whatever the verdict; only a summary of a tree that was
    // never the subject must stay off stdout, and that is pinned by the test above.
    it('keeps the guarded tree inventory on stdout even when the verdict is red', () => {
      const { status, stdout, stderr } = runGuard(WEDGE);
      expect(status).toBe(1);
      expect(stdout).toContain('executors, 1 inspected');
      expect(stderr).toMatch(/server\.listen\(port\)/);
    });

    it('reports a FILE named as the scan root as a message, not an ENOTDIR stack trace', () => {
      const run = spawnSync('node', [GUARD, 'src/server.ts'], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('Nothing to inspect');
      expect(run.stderr).not.toMatch(/^\s+at .*\(node:/m);
    });

    // The third way a root refuses to be read, and the one the walk survives: `chmod 444` on a
    // directory lists its names and refuses to stat its entries, so the only read that dies is the
    // lstat on the mark, long after the try/catch around the walk. It was unguarded until #77.
    it('reports an unreadable scan root as a message, not an EACCES stack trace', () => {
      const dir = mkdtempSync(join(tmpdir(), 'executor-guard-'));
      temps.push(dir);
      writeFileSync(join(dir, 'server.ts'), MARK);
      chmodSync(dir, 0o444);
      try {
        const run = spawnSync('node', [GUARD, dir], { encoding: 'utf8' });
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('Nothing to inspect');
        expect(run.stderr).not.toMatch(/^\s+at .*\(node:/m);
      } finally {
        chmodSync(dir, 0o755); // or afterEach cannot remove it
      }
    });

    // The empty string passed the arity gate and resolved to the repo root, so the guard walked
    // node_modules and reported zod's test files as its inventory.
    it('refuses the empty string instead of walking the repo root', () => {
      const run = spawnSync('node', [GUARD, ''], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('not the empty string');
      expect(run.stderr).not.toContain('node_modules');
    });

    // ONE ABLATION PER RULE, as for the detection rules below: remove the rule from a copy of the
    // guard and the fixture that pins it must change its verdict. A rule no fixture distinguishes
    // fails here, now.
    it('ablated: a mark that is not stat-ed accepts a directory and a symlink again', () => {
      const ablated = mutate([[' && lstatSync(ENTRY_PATH).isFile()', '']]);
      for (const what of ['a directory', 'a symlink out of the tree'] as const) {
        const run = spawnSync('node', [ablated, misMarked(MIS_MARKS[what])], { encoding: 'utf8' });
        expect(run.status, what).toBe(0);
      }
    });

    it('ablated: a stream that ignores the mark reports a tree it was never pointed at', () => {
      const ablated = mutate([
        ['const report = marked ? console.log : console.error;', 'const report = console.log;'],
      ]);
      const run = spawnSync('node', [ablated, 'tests/util'], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('Promise executors in');
    });

    it('ablated: without the ENOTDIR catch, a file root dies as a stack trace', () => {
      const ablated = mutate([['} catch (err) {', "} catch (err) {\n  if (err.code === 'ENOTDIR') throw err;"]]);
      const run = spawnSync('node', [ablated, 'src/server.ts'], { encoding: 'utf8' });
      expect(run.stderr).not.toContain('Nothing to inspect');
      expect(run.stderr).toContain('node:fs');
    });

    it('ablated: without the empty-string check, the empty root walks the repo root', () => {
      const ablated = mutate([['process.argv.length !== 3 || !process.argv[2]', 'process.argv.length !== 3']]);
      const run = spawnSync('node', [ablated, ''], { encoding: 'utf8' });
      expect(run.stderr).not.toContain('not the empty string');
      // Both streams: which one the inventory lands on is the neighbouring rule's business.
      expect(run.stdout + run.stderr).toContain('node_modules');
    });

    // THE HEADER'S COUNT, EXECUTED — the sibling guard's header claim was wrong three times in one
    // PR while it lived on paper only. Run the documented command and the next drift is red here.
    it('runs the counting command from the script header and gets src/server.ts, nothing else', () => {
      const COUNT = String.raw`git ls-files '*/server.ts' 'server.ts'`;
      // Read out of the header, not retyped: a header that drifts from the command actually run
      // would put the claim back on paper only.
      expect(readFileSync(GUARD, 'utf8')).toContain(COUNT);
      const run = spawnSync('sh', ['-c', COUNT], { cwd: root, encoding: 'utf8' });
      expect(run.stdout.trim().split('\n')).toEqual(['src/server.ts']);
    });
  });

  // #85. The scan ROOT refusals above are about pointing the guard at the wrong tree. These are
  // about the right tree with a file missing from it: the file is collected, counted as scanned,
  // and never walked. The wedge in each fixture is the same nested unguarded `danger()` that w1
  // reports normally, so a verdict of 0 executors here is the guard crediting a file it never read.
  describe('#85 — a file the walk never saw is refused, not counted clean', () => {
    const WEDGE = 'export const p = new Promise((a, b) => { new Promise((r) => { danger(); r(1); }); a(1); });\n';

    // chmod 000 on the file, not on the directory: the walk lists it, ts.createProgram cannot open
    // it, and getSourceFile returns undefined. The 0o000 is restored so afterEach can remove it.
    function withUnreadableFile(run: (target: string) => Run): Run {
      const target = fixtureDir(WEDGE, 'w.ts');
      const file = join(target, 'w.ts');
      chmodSync(file, 0o000);
      try {
        return run(target);
      } finally {
        chmodSync(file, 0o644);
      }
    }

    it('refuses a tree holding a file the compiler could not open, and names that file', () => {
      const run = withUnreadableFile((t) => spawnSync('node', [GUARD, t], { encoding: 'utf8' }) as Run);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('could not be read');
      expect(run.stderr).toContain('w.ts');
      expect(run.stderr).not.toMatch(/^\s+at .*\(node:/m);
    });

    // An unterminated template literal on line 1: the AST stops there, so the executor below it is
    // not merely unflagged, it is absent. The position is asserted because "somewhere in this file"
    // is not enough to act on.
    it('refuses a tree holding a file that does not parse, and names the file and the position', () => {
      const run = runGuard(`const s = \`unterminated\n${WEDGE}`, 'broken.ts');
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('did not parse');
      expect(run.stderr).toMatch(/broken\.ts:\d+:\d+/);
      expect(run.stderr).toContain('Unterminated template literal');
    });

    // The same breakage in the MARKED file itself, which is the case that would otherwise read as
    // the most trustworthy run there is: the tree carries its mark and reports nothing.
    it('refuses it in server.ts itself, the file the mark points at', () => {
      const dir = mkdtempSync(join(tmpdir(), 'executor-guard-'));
      temps.push(dir);
      writeFileSync(join(dir, 'server.ts'), `const s = \`unterminated\n${WEDGE}`);
      const run = spawnSync('node', [GUARD, dir], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('did not parse');
      expect(run.stderr).toContain('server.ts');
    });

    // Semantic diagnostics are deliberately not consulted: the program runs with noLib/noResolve,
    // so src/ itself carries hundreds of them. A tree that only offends the type checker must pass.
    it('does not refuse a file that merely fails the type checker', () => {
      const run = runGuard('export const n: number = "not a number";\n');
      expect(run.stderr).not.toContain('did not parse');
      expect(run.status).toBe(0);
    });

    // Dropping the file instead of naming it IS the pre-#85 code: the old `if (!source) continue;`
    // by another spelling. Measured state it restores: 0 executors, exit 0, the wedge unseen.
    it('ablated: without the unread-file refusal, the unreadable file is credited clean', () => {
      const ablated = mutate([
        ['  unread.push(`${relative(root, file)}  (could not be read)`);', '  void 0;'],
      ]);
      const run = withUnreadableFile((t) => spawnSync('node', [ablated, t], { encoding: 'utf8' }) as Run);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('0 executors, 0 inspected');
    });

    it('ablated: without the syntactic-diagnostic refusal, the wedge below the breakage is gone', () => {
      const ablated = mutate([['for (const d of program.getSyntacticDiagnostics()) {', 'for (const d of []) {']]);
      const run = spawnSync('node', [ablated, fixtureDir(`const s = \`unterminated\n${WEDGE}`, 'broken.ts')], {
        encoding: 'utf8',
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('0 executors, 0 inspected');
    });
  });

  describe('the tree it guards', () => {
    it('passes src/ and reports every executor it found, with its real parameter names', () => {
      const { status, stdout } = runGuard();
      expect(status).toBe(0);
      expect(stdout).toContain('src/auth/oauth-flow.ts');
      expect(stdout).toContain('src/client/job-poller.ts');
      expect(stdout).toContain('src/client/rate-limiter.ts');
      expect(stdout).toContain('(bound, bindFailed)');
      expect(stdout).toMatch(
        /src\/auth\/oauth-flow\.ts:\d+:\d+\s+\(resolve, reject\)\s+nested, inspected/,
      );
    });

    it('lists each executor exactly once, however deep the nesting', () => {
      const { stdout } = runGuard(`
export const f = () =>
  new Promise<void>((a1, r1) => {
    const p2 = new Promise<void>((a2, r2) => {
      const p3 = new Promise<void>((a3, r3) => {
        try { (globalThis as unknown as { boom: () => void }).boom(); } catch (e) { r1(e as Error); }
        a3();
      });
      p3.catch(() => {});
      a2();
    });
    p2.catch(() => {});
    a1();
  });
`);
      expect(stdout.match(/subject\.ts:\d+:\d+/g)).toHaveLength(3);
      expect(stdout).toContain('3 executors, 2 inspected');
    });

    it('is wired into npm and into CI, so a violation turns the build red', () => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.scripts['check:executors']).toBe('node scripts/assert-executor-safety.mjs src');
      expect(pkg.devDependencies.typescript).toBeDefined(); // the guard's only import, already there
      expect(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')).toContain(
        'npm run check:executors',
      );
    });
  });

  // Three times in this ticket a negative test passed for a reason other than the rule it claimed
  // to pin — twice on the core `throw`-is-not-a-settle rule, once on w5 and once on w7. Attention
  // is evidently not enough, so the property is asserted directly: ablate a rule, and the fixture
  // that pins it must change its verdict. A rule no fixture distinguishes fails HERE, now.
  describe('mutation coverage — every core rule is pinned by a fixture that notices its absence', () => {
    const CASES: Array<{
      rule: string;
      edits: Array<[string, string]>;
      source: string;
      fileName?: string;
      baseline: (r: Run) => void;
      ablated: (r: Run) => void;
    }> = [
      {
        rule: 'a bare throw is not a settle',
        edits: [
          [
            'return settlers.has(calleeSymbol(call));',
            'return settlers.has(calleeSymbol(call)) || ts.isThrowStatement(statement);',
          ],
        ],
        source: bareThrow(WEDGE),
        baseline: (r) => expect(r.status).toBe(1),
        ablated: (r) => expect(r.status).toBe(0),
      },
      {
        rule: 'async executors are inspected',
        edits: [['const inspect = nested || asyncExecutor;', 'const inspect = nested;']],
        source: ASYNC_WEDGE,
        baseline: (r) => expect(r.status).toBe(1),
        ablated: (r) => expect(r.status).toBe(0),
      },
      {
        rule: 'settlers resolve by binding, not by name',
        edits: [
          ['    ? symbolOf(node.expression)', '    ? node.expression.text'],
          [
            'symbols: params.map((p) => (ts.isIdentifier(p.name) ? symbolOf(p.name) : undefined)),',
            'symbols: params.map((p) => (ts.isIdentifier(p.name) ? p.name.text : undefined)),',
          ],
        ],
        source: outerSettle(
          WEDGE.replace('(bound, bindFailed)', '(resolve, reject)').replace(
            'bound();',
            'resolve();',
          ),
          'reject',
        ),
        baseline: (r) => expect(r.status).toBe(1),
        ablated: (r) => expect(r.status).toBe(0),
      },
      {
        rule: 'the catch must settle unconditionally',
        edits: [
          [
            '        if (settles) {',
            '        let anywhere = false;\n        walkSync(node.catchClause.block, (n) => { if (settlers.has(calleeSymbol(n))) anywhere = true; });\n        if (settles || anywhere) {',
          ],
        ],
        source: WEDGE.replace(
          'server.listen(port);',
          'try { server.listen(port); } catch (e) { if (port > 0) bindFailed(e as Error); }',
        ),
        baseline: (r) => expect(r.status).toBe(1),
        ablated: (r) => expect(r.status).toBe(0),
      },
      {
        rule: 'an executor named through a variable is followed',
        edits: [['  if (!ts.isIdentifier(node)) return null;', '  return null;']],
        source: `
const exec = (resolve: (v: void) => void) => {
  (globalThis as unknown as { boom: () => void }).boom();
  resolve();
};
export const f = () =>
  new Promise<void>((bound, bindFailed) => {
    const inner = new Promise<void>(exec);
    inner.catch(() => {});
    bound();
  });
`,
        baseline: (r) => expect(r.status).toBe(1),
        ablated: (r) => expect(r.status).toBe(0),
      },
      {
        rule: 'a call chain is reported once',
        edits: [
          [
            '        return false;\n      };\n      if (check(executor.body) !== false)',
            '        return true;\n      };\n      if (check(executor.body) !== false)',
          ],
        ],
        source: `
export const f = (items: string[]) =>
  new Promise<void>((bound, bindFailed) => {
    const inner = new Promise<void>((resolve) => {
      const s = items.map((i) => i).filter((i) => i.length > 0).join(',');
      resolve();
    });
    inner.catch(() => {});
    bound();
  });
`,
        baseline: (r) => expect(r.stderr.match(/subject\.ts:\d+:\d+/g)).toHaveLength(1),
        ablated: (r) => expect(r.stderr.match(/subject\.ts:\d+:\d+/g)!.length).toBeGreaterThan(1),
      },
      {
        rule: 'the hint never invents a reject parameter',
        edits: [
          [
            'const settleName = (nested ? ancestors[ancestors.length - 1] : own).rejectName;',
            'const _t = nested ? ancestors[ancestors.length - 1] : own;\n      const settleName = _t.rejectName ?? _t.names[0];',
          ],
        ],
        source: `
export const f = (port: number, server: { listen: (p: number) => void }) =>
  new Promise<void>((bound) => {
    const inner = new Promise<void>((resolve) => {
      server.listen(port);
      resolve();
    });
    inner.catch(() => {});
  });
`,
        baseline: (r) => expect(r.stderr).toContain('declares no reject parameter'),
        ablated: (r) => expect(r.stderr).toContain('bound(err)'),
      },
      {
        rule: 'the settle expression is exempt inside a settling catch',
        edits: [['return !within(settlingCatches, node);', 'return true;']],
        source: SETTLE_IN_CATCH,
        baseline: (r) => expect(r.status).toBe(0),
        ablated: (r) => expect(r.status).toBe(1),
      },
      {
        rule: 'that exemption does not reach beyond the catch',
        edits: [['return !within(settlingCatches, node);', 'return false;']],
        source: SETTLE_ARG_ON_HAPPY_PATH,
        baseline: (r) => expect(r.status).toBe(1),
        ablated: (r) => expect(r.status).toBe(0),
      },
      {
        rule: 'the remedy advice matches the executor kind',
        edits: [['    nested\n      ? ', '    true\n      ? ']],
        source: ASYNC_WEDGE,
        baseline: (r) => expect(r.stderr).toContain('an async executor IS the top level'),
        ablated: (r) => expect(r.stderr).toContain('PREFER moving the call out'),
      },
      {
        rule: 'tsx/mts/cts are collected',
        edits: [['const SOURCE = /\\.(ts|tsx|mts|cts)$/;', 'const SOURCE = /\\.ts$/;']],
        source: WEDGE,
        fileName: 'subject.tsx',
        baseline: (r) => expect(r.status).toBe(1),
        ablated: (r) => expect(r.status).toBe(0),
      },
    ];

    it.each(CASES)('$rule', ({ edits, source, fileName, baseline, ablated }) => {
      baseline(runGuard(source, fileName));
      ablated(runMutant(edits, source, fileName));
    });
  });
});
