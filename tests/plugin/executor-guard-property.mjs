// tests/plugin/executor-guard-property.mjs
// A property-based generator and shrinker for scripts/assert-executor-safety.mjs (#76).
//
// WHY HAND-WRITTEN. There is no fast-check in this tree and adding a dependency needs approval, so
// the generator, the PRNG and the shrinker are all here. That is cheaper than it sounds: the space
// under test is not arbitrary data but a FILESYSTEM SHAPE plus an ARGV SPELLING, and no off-the-
// shelf arbitrary generates those. 80 lines of generator beat a dependency that would still need
// a custom arbitrary.
//
// WHAT IS GENERATED — a `Case` record, from which `materialise` builds a real tree on disk:
//   argv    : how many roots are passed, and how the one that matters is SPELLED
//             (absolute · relative-to-repo-root · trailing slash · `/./` · `/x/..` roundtrip ·
//              a component with a space, a newline, an emoji, NFD-composed umlauts · leading `-`)
//   kind    : what the named path IS (directory · regular file · missing · symlink to a directory ·
//             dangling symlink)
//   marker  : what `server.ts` IS in that directory (absent · regular file · directory ·
//             symlink to a file outside the tree · dangling symlink · wrong case `Server.ts` ·
//             `server.tsx` · present only in a SUBdirectory)
//   files   : 0..3 generated .ts/.tsx/.mts/.cts sources at depth 0..2, each CLEAN or a WEDGE
//             (the #9 shape: a call on the synchronous path of a nested executor), optionally
//             behind a SYMLINKED subdirectory
//
// The properties live in executor-guard-properties.test.ts; this module only generates, runs and
// shrinks. Everything is seeded: `run(seed, n)` is reproducible, and a failure is reported as the
// SHRUNK case so it reproduces as a fixed record without the generator.
// THE CONTRACT, IN JSDOC, so the test files that import this module are type-checked against it
// (#57) and the shapes are written down once where they are produced rather than at each call site.
// The module itself stays plain JS and is not type-checked (`checkJs: false`); these annotations
// exist for inference, which is why a drift between them and the code below is a defect in them.
/**
 * @typedef {{ ext: string, depth: number, wedge: boolean, behindSymlinkDir: boolean }} GeneratedFile
 * @typedef {{ roots: number, spelling: string, kind: string, marker: string, emptyArg: boolean,
 *             files: GeneratedFile[] }} Case
 * @typedef {{ argv: string[], scanned: string | null }} Built
 * @typedef {{ status: number, signal: string | null, stdout: string, stderr: string }} Result
 * @typedef {{ seed: number, index: number, original: Case, minimal: Case, message: string }} Failure
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GUARD = join(REPO, 'scripts', 'assert-executor-safety.mjs');

// mulberry32 — a seeded PRNG, so every case in this file is replayable from its seed alone.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rnd, xs) => xs[Math.floor(rnd() * xs.length)];
const int = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

// The exact #9 shape: a call on the synchronous path of an executor nested in another one, with the
// inner rejection swallowed. A guard that exits 0 over this has lost a finding.
export const WEDGE = `
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
export const CLEAN = `export const value = 1;\n`;

export const ARGV_SPELLINGS = [
  'absolute',
  'trailing-slash',
  'dot-segment',
  'dotdot-roundtrip',
  'space',
  'newline',
  'emoji',
  'nfd',
  'leading-dash',
];
export const PATH_KINDS = ['dir', 'file', 'missing', 'symlink-dir', 'dangling'];
export const MARKER_KINDS = [
  'absent',
  'file',
  'directory',
  'symlink-out',
  'dangling',
  'wrong-case',
  'tsx',
  'subdir-only',
];
export const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts'];

/** @param {() => number} rnd @returns {Case} */
export function generate(rnd) {
  const files = [];
  for (let i = 0, n = int(rnd, 0, 3); i < n; i += 1) {
    files.push({
      ext: pick(rnd, EXTENSIONS),
      depth: int(rnd, 0, 2),
      wedge: rnd() < 0.5,
      behindSymlinkDir: rnd() < 0.15,
    });
  }
  return {
    roots: int(rnd, 0, 2) === 0 ? 1 : pick(rnd, [0, 1, 1, 1, 2]),
    spelling: pick(rnd, ARGV_SPELLINGS),
    kind: pick(rnd, PATH_KINDS),
    marker: pick(rnd, MARKER_KINDS),
    emptyArg: rnd() < 0.05,
    files,
  };
}

const DECORATION = {
  space: 'a dir',
  newline: 'a\ndir',
  emoji: 'dir-\u{1f6a7}',
  nfd: 'über', // u + combining diaeresis: NFD, which APFS stores as given
};

// Builds the case on disk and returns { argv, scanned } — scanned is the real directory the argv is
// meant to name, or null when the case deliberately names something that is not a directory.
/** @param {Case} c @param {string[]} temps @returns {Built} */
export function materialise(c, temps) {
  const base = mkdtempSync(join(tmpdir(), 'exec-prop-'));
  temps.push(base);
  const component = DECORATION[c.spelling] ?? 'tree';
  const dir = join(base, component);
  mkdirSync(dir, { recursive: true });

  for (const [i, f] of c.files.entries()) {
    const parts = Array.from({ length: f.depth }, (_, d) => `d${d}`);
    let host = join(dir, ...parts);
    mkdirSync(host, { recursive: true });
    if (f.behindSymlinkDir) {
      // The real content lives OUTSIDE the scanned tree and is reached through a symlinked
      // directory inside it — node's recursive readdir does not descend into those.
      const real = join(base, `real${i}`);
      mkdirSync(real, { recursive: true });
      try {
        symlinkSync(real, join(host, `link${i}`));
        host = real;
      } catch {
        /* a filesystem without symlinks degrades to the plain case */
      }
    }
    writeFileSync(join(host, `f${i}${f.ext}`), f.wedge ? WEDGE : CLEAN);
  }

  if (c.marker === 'file') writeFileSync(join(dir, 'server.ts'), '// mark\n');
  if (c.marker === 'directory') mkdirSync(join(dir, 'server.ts'));
  if (c.marker === 'wrong-case') writeFileSync(join(dir, 'Server.ts'), '// mark\n');
  if (c.marker === 'tsx') writeFileSync(join(dir, 'server.tsx'), '// mark\n');
  if (c.marker === 'symlink-out') {
    const outside = join(base, 'outside.ts');
    writeFileSync(outside, '// mark\n');
    symlinkSync(outside, join(dir, 'server.ts'));
  }
  if (c.marker === 'dangling') symlinkSync(join(base, 'gone.ts'), join(dir, 'server.ts'));
  if (c.marker === 'subdir-only') {
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'server.ts'), '// mark\n');
  }

  let named = dir;
  let scanned = dir;
  if (c.kind === 'file') {
    named = join(dir, 'standalone.ts');
    writeFileSync(named, CLEAN);
    scanned = null;
  } else if (c.kind === 'missing') {
    named = join(dir, 'no-such-subtree');
    scanned = null;
  } else if (c.kind === 'symlink-dir') {
    named = join(base, 'link-to-tree');
    symlinkSync(dir, named);
  } else if (c.kind === 'dangling') {
    named = join(base, 'dangling-link');
    symlinkSync(join(base, 'gone'), named);
    scanned = null;
  }

  if (c.spelling === 'trailing-slash') named = `${named}/`;
  else if (c.spelling === 'dot-segment') named = join(named, '.');
  else if (c.spelling === 'dotdot-roundtrip') named = join(named, 'x', '..');
  else if (c.spelling === 'leading-dash' && c.kind === 'dir') {
    const dashed = join(base, '-dashed');
    symlinkSync(dir, dashed);
    named = dashed;
  }

  const argv = [];
  if (c.roots >= 1) argv.push(c.emptyArg ? '' : named);
  if (c.roots === 2) argv.push(join(base, 'second-root'));
  return { argv, scanned, dir };
}

// `guard` is a parameter so a property can be replayed against a PATCHED copy of the script. That
// is how a failing property is shown not to be vacuous: it must pass against the fix and fail here.
/** @param {string[]} argv @param {string} [guard] @returns {Result} */
export function execute(argv, guard = process.env.EXECUTOR_GUARD || GUARD) {
  const r = spawnSync('node', [guard, ...argv], { encoding: 'utf8', timeout: 120000 });
  return { status: r.status ?? -1, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Every `path:line:column` the run named, in either stream — the findings, independent of wording.
/** @type {(out: string) => string[]} */
export const locations = (out) => (out.match(/[\w./\\-]+\.(?:ts|tsx|mts|cts):\d+:\d+/g) ?? []).sort();

// The same run, without blocking: one guard run costs ~200 ms of node startup and `typescript`
// import, so a sequential pass over n trees costs n * 200 ms and nothing else. The cases are
// independent, so the HOT PATH runs them in a pool and the sequential `execute` above stays for the
// shrinker, which is inherently serial and only ever runs after a failure.
/** @param {string[]} argv @param {string} [guard] @returns {Promise<Result>} */
export function executeAsync(argv, guard = process.env.EXECUTOR_GUARD || GUARD) {
  return new Promise((done) => {
    const child = spawn('node', [guard, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('close', (status, signal) => done({ status: status ?? -1, signal, stdout, stderr }));
  });
}

/**
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {number} [concurrency]
 * @returns {Promise<R[]>}
 */
export async function pool(items, worker, concurrency = 8) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return out;
}

// SHRINKING. The case is a record, so shrinking is "try every smaller record, keep the first that
// still fails". Candidates are ordered cheapest-first: drop a file, de-wedge a file, un-decorate the
// path, move the marker towards a plain file, straighten the path kind. The loop runs until no
// candidate reproduces, which is the local minimum this reports.
/** @param {Case} c @returns {Case[]} */
export function shrinkCandidates(c) {
  const out = [];
  for (let i = 0; i < c.files.length; i += 1) {
    out.push({ ...c, files: c.files.filter((_, j) => j !== i) });
  }
  for (let i = 0; i < c.files.length; i += 1) {
    const f = c.files[i];
    const simpler = [];
    if (f.behindSymlinkDir) simpler.push({ ...f, behindSymlinkDir: false });
    if (f.depth > 0) simpler.push({ ...f, depth: f.depth - 1 });
    if (f.ext !== '.ts') simpler.push({ ...f, ext: '.ts' });
    if (f.wedge) simpler.push({ ...f, wedge: false });
    for (const s of simpler) out.push({ ...c, files: c.files.map((g, j) => (j === i ? s : g)) });
  }
  if (c.emptyArg) out.push({ ...c, emptyArg: false });
  if (c.spelling !== 'absolute') out.push({ ...c, spelling: 'absolute' });
  if (c.marker !== 'absent' && c.marker !== 'file') out.push({ ...c, marker: 'file' });
  if (c.marker === 'file') out.push({ ...c, marker: 'absent' });
  if (c.kind !== 'dir') out.push({ ...c, kind: 'dir' });
  if (c.roots !== 1) out.push({ ...c, roots: 1 });
  return out;
}

/** @param {Case} c @param {(candidate: Case) => boolean} fails @param {number} [budget] @returns {Case} */
export function shrink(c, fails, budget = 400) {
  let best = c;
  let spent = 0;
  let improved = true;
  while (improved && spent < budget) {
    improved = false;
    for (const candidate of shrinkCandidates(best)) {
      if (spent >= budget) break;
      spent += 1;
      if (fails(candidate)) {
        best = candidate;
        improved = true;
        break;
      }
    }
  }
  return best;
}

// The hot-path entry point, and the only one: runs `property(case, result, materialised)` over n
// generated cases, where a property THROWS to fail. The first failure is shrunk and returned; null
// means the whole batch held. It generates n cases, runs them all in a pool, then evaluates the
// property in generation order so the FIRST failure is deterministic for a given seed. Shrinking
// the failure falls back to the serial path, which costs nothing on a green run.
/**
 * @param {(c: Case, r: Result, m: Built) => void} property  throws to fail
 * @param {{ seed?: number, n?: number, concurrency?: number }} [options]
 * @returns {Promise<Failure | null>}
 */
export async function checkParallel(property, { seed = 1, n = 32, concurrency = 8 } = {}) {
  const rnd = prng(seed);
  const temps = [];
  try {
    const cases = Array.from({ length: n }, () => generate(rnd));
    const built = cases.map((c) => materialise(c, temps));
    const results = await pool(built, (m) => executeAsync(m.argv), concurrency);
    for (const [i, c] of cases.entries()) {
      try {
        property(c, results[i], built[i]);
      } catch (error) {
        const fails = (candidate) => {
          try {
            const m = materialise(candidate, temps);
            property(candidate, execute(m.argv), m);
            return false;
          } catch {
            return true;
          }
        };
        const minimal = shrink(c, fails);
        let message = String(error?.message ?? error);
        try {
          const m = materialise(minimal, temps);
          property(minimal, execute(m.argv), m);
        } catch (err) {
          message = String(err?.message ?? err);
        }
        return { seed, index: i, original: c, minimal, message };
      }
    }
    return null;
  } finally {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
  }
}
