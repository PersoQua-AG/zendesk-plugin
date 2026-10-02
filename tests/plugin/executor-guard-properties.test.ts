// Property-based tests for scripts/assert-executor-safety.mjs — the generator, the shrinker, the
// PRNG and the process pool live in ./executor-guard-property.mjs; this file states the properties.
//
// WHY PROPERTIES AND NOT MORE FIXTURES. executor-safety-guard.test.ts pins the WALK with hand-built
// sources, one verdict per fixture. What no fixture reaches is the product of the two surfaces the
// caller controls after #76: how the scan root is SPELLED and what the mark on disk IS. That product
// is ~360 shapes before file contents, so it is generated, and every case here is a real run of the
// real script over a real tree.
//
// WHAT PINS WHAT, because the two halves do different jobs. The generated pass SEARCHES: one seed,
// 32 trees, and its job is to turn up a shape nobody wrote down. The FIXED table below PINS: every
// case in it is a shrunk minimum this generator actually found, and those are what keep a rule from
// regressing — a search with a different seed could miss them, a fixed case cannot. So the seed count
// is a coverage dial and not a safety one. The wide search is a command, not a default:
//
//   PROPERTY_SEEDS=1,2,3,4,5 PROPERTY_CASES=40 npx vitest run tests/plugin/executor-guard-properties
//
// which is 200 trees and ~6 s. The default is one seed because this file sits on every local run and
// on both CI runs, and 20 s there buys a search that the fixed table already covers.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkParallel, executeAsync, locations, pool, WEDGE } from './executor-guard-property.mjs';

const SEEDS = (process.env.PROPERTY_SEEDS ?? '1').split(',').map(Number);
const CASES = Number(process.env.PROPERTY_CASES ?? 32);
const BUDGET = 120_000;

const assert = (ok: unknown, message: string): void => {
  if (!ok) throw new Error(message);
};

const temps: string[] = [];
afterAll(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempdir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};

describe('assert-executor-safety: generated properties', () => {
  it(
    `holds every invariant over ${CASES} generated trees (seeds ${SEEDS.join(',')})`,
    async () => {
      // All invariants are checked in ONE pass over the generated cases, not one pass each: a guard
      // run costs ~200 ms of node startup and `typescript` import, so a pass per invariant would
      // multiply the only expensive thing here to buy nothing. A failure still names which broke.
      for (const seed of SEEDS) {
        const bad = await checkParallel((c, r, m) => {
          // The tree the guard is FOR, from the case record rather than from the guard's own output:
          // a scanned directory, named as the single non-empty root, whose server.ts is a regular
          // file the walk collected. Every other marker spelling is some other tree.
          const guarded = m.scanned != null && c.marker === 'file' && c.roots === 1 && !c.emptyArg;

          // I1 — the process always reaches its own exit, over every argv and every tree shape.
          assert(r.signal == null, `I1: killed by ${r.signal}`);
          assert(r.status === 0 || r.status === 1, `I1: status ${r.status}`);

          // I2 — exit 0 never coexists with a named problem.
          if (r.status === 0) {
            assert(!/Refusing the tree/.test(r.stderr), 'I2: exit 0 with problems reported');
            assert(locations(r.stderr).length === 0, `I2: exit 0 names findings: ${locations(r.stderr)}`);
          }

          // I3 — the mark is exactly a collected regular server.ts, and exit 0 is impossible without
          // it. A directory of that name, a `Server.ts` on this case-folding filesystem, an outbound
          // symlink and a dangling one are all other trees.
          const refused = /Expected exactly one|Nothing to inspect/.test(r.stderr);
          const marked = !refused && !/Not the guarded tree/.test(r.stderr);
          assert(refused || guarded === marked, `I3: marked=${marked} guarded=${guarded} marker=${c.marker}`);
          if (r.status === 0) assert(guarded, `I3: exit 0 over an unguarded tree (marker=${c.marker})`);

          // I4 — any arity but one root, and the empty string, are refused in words.
          if (c.roots !== 1 || c.emptyArg) {
            assert(r.status === 1, `I4: ${c.roots} roots accepted with status ${r.status}`);
            assert(
              /Expected exactly one scan root/.test(r.stderr),
              `I4: no refusal:\n${r.stderr.slice(0, 200)}`,
            );
          }

          // I5 — the stream is keyed on the mark, not on the verdict: the guarded tree's inventory is
          // a true record whether the run is green or red, and a tree that was never the subject
          // never writes a summary to stdout.
          if (guarded) {
            assert(/Promise executors in/.test(r.stdout), 'I5: guarded tree not reported on stdout');
            assert(!/Promise executors in/.test(r.stderr), 'I5: guarded tree reported on stderr too');
          } else {
            assert(r.stdout === '', `I5: unguarded tree wrote to stdout:\n${r.stdout.slice(0, 200)}`);
          }

          // I6 — the one thing a guard may not do: lose a wedge in the tree it was told to scan. The
          // precondition is that a scan happened; a run refused for its argv is a refusal, not a
          // lost finding, and I4 covers those.
          if (m.scanned == null || c.roots !== 1 || c.emptyArg) return;
          if (!c.files.some((f) => f.wedge && f.ext !== '.d.ts')) return;
          assert(/server\.listen\(port\)/.test(r.stderr), `I6: wedge unreported: ${JSON.stringify(c.files)}`);
          assert(r.status === 1, `I6: wedge present but status ${r.status}`);
        }, { seed, n: CASES });
        expect(
          bad,
          bad ? `seed=${seed} shrunk=${JSON.stringify(bad.minimal)}\n${bad.message}` : '',
        ).toBeNull();
      }
    },
    BUDGET,
  );
});

// EVERY CASE HERE IS A SHRUNK MINIMUM THE GENERATOR FOUND, replayed as a fixed record so it
// reproduces without the generator and cannot be missed by a seed. The first six were green on
// 3ee1d43 — they are the defects #76 and its fix closed, and they are the control for each rule.
describe('assert-executor-safety: the shrunk counterexamples, as fixed cases', () => {
  type Case = {
    what: string;
    build: (dir: string) => string[]; // → the argv to pass
    expect: (r: Awaited<ReturnType<typeof executeAsync>>) => void;
  };
  const mark = (dir: string): void => writeFileSync(join(dir, 'server.ts'), '// mark\n');
  const unguarded = (r: Awaited<ReturnType<typeof executeAsync>>): void => {
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Not the guarded tree');
    expect(r.stdout).toBe('');
  };

  const CASES_: Case[] = [
    {
      what: 'a DIRECTORY named server.ts is not the module the build bundles',
      build: (d) => {
        mkdirSync(join(d, 'server.ts'));
        return [d];
      },
      expect: unguarded,
    },
    {
      what: 'a Server.ts does not mark the tree on a case-folding filesystem',
      // This host is darwin: existsSync('server.ts') says yes to a file named Server.ts, so the old
      // mark gave one tree two verdicts by platform — green here, red on Linux CI.
      build: (d) => {
        writeFileSync(join(d, 'Server.ts'), '// not the mark\n');
        return [d];
      },
      expect: unguarded,
    },
    {
      what: 'a server.ts symlinked to a file OUTSIDE the scanned tree does not mark it',
      build: (d) => {
        const outside = join(d, '..', 'outside.ts');
        writeFileSync(outside, '// mark\n');
        symlinkSync(outside, join(d, 'server.ts'));
        return [d];
      },
      expect: unguarded,
    },
    {
      what: 'a DANGLING server.ts symlink does not mark the tree',
      build: (d) => {
        symlinkSync(join(d, 'gone.ts'), join(d, 'server.ts'));
        return [d];
      },
      expect: unguarded,
    },
    {
      what: 'a scan root that is a FILE is named, not a stack trace',
      build: (d) => {
        mark(d);
        return [join(d, 'server.ts')];
      },
      expect: (r) => {
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/Nothing to inspect: .*server\.ts \(ENOTDIR\)\./);
        expect(r.stderr).not.toMatch(/^\s+at .*\(node:/m);
        expect(r.stdout).toBe('');
      },
    },
    {
      what: 'the empty string is refused as a root instead of resolving to the repository root',
      // `resolve(root, '')` is the repo root, which walks node_modules: measured on 3ee1d43 as
      // 49 executors, among them a zod test file.
      build: () => [''],
      expect: (r) => {
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('not the empty string');
        expect(r.stderr).not.toMatch(/node_modules/);
      },
    },
    {
      what: 'a missing root is named, not a stack trace',
      build: (d) => [join(d, 'no-such-subtree')],
      expect: (r) => {
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/Nothing to inspect: .* \(ENOENT\)\./);
        expect(r.stderr).not.toMatch(/^\s+at .*\(node:/m);
      },
    },
    {
      what: 'no root at all is refused',
      build: () => [],
      expect: (r) => {
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('Expected exactly one scan root');
      },
    },
    {
      what: 'a second root is refused rather than silently dropped',
      build: (d) => {
        mark(d);
        return [d, join(d, '..', 'second')];
      },
      expect: (r) => {
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('Expected exactly one scan root');
        expect(r.stdout).toBe('');
      },
    },
    {
      what: 'the guarded tree reports on stdout even when the verdict is red',
      // The stream is keyed on the mark, not on the exit code. Red here, and the inventory is still
      // a true record of what was inspected — while the findings stay on stderr, so a reader
      // counting `file:line:col` cannot confuse the two.
      build: (d) => {
        mark(d);
        writeFileSync(join(d, 'w.ts'), WEDGE);
        return [d];
      },
      expect: (r) => {
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('Promise executors in');
        expect(r.stdout).toContain('nested, inspected');
        expect(r.stderr).toMatch(/w\.ts:5:\d+\s+server\.listen\(port\)/);
        expect(r.stderr).not.toContain('Promise executors in');
      },
    },
  ];

  it(
    'every one of them',
    async () => {
      // One pool, not ten sequential runs: each case is an independent process.
      const built = CASES_.map((c) => {
        const dir = join(tempdir('exec-fixed-'), 'src');
        mkdirSync(dir, { recursive: true });
        return c.build(dir);
      });
      const results = await pool(built, (argv) => executeAsync(argv));
      // Every case is reported, not just the first: this table doubles as the control sheet, and a
      // run against an ablated guard has to say which rules noticed and which did not.
      const broken: string[] = [];
      for (const [i, c] of CASES_.entries()) {
        try {
          c.expect(results[i]);
        } catch (err) {
          broken.push(`  - ${c.what}: ${(err as Error).message.split('\n')[0]}`);
        }
      }
      expect(broken.join('\n'), `\n${broken.join('\n')}`).toBe('');
    },
    BUDGET,
  );
});

describe('assert-executor-safety: the scan root the caller spells', () => {
  // New coverage rather than a #76 discriminator: both of these also hold on 3ee1d43. They are here
  // because the script header leans on them — "a too-wide root still inspects the guarded file" is
  // only harmless if nothing drops out — and neither was executed anywhere before.
  it(
    'gives one verdict and one finding set however the same directory is spelled, and loses nothing to a wider root',
    async () => {
      const base = tempdir('exec-spelling-');
      const dir = join(base, 'src');
      mkdirSync(join(dir, 'deep'), { recursive: true });
      writeFileSync(join(dir, 'server.ts'), '// mark\n');
      writeFileSync(join(dir, 'deep', 'w.ts'), WEDGE);
      symlinkSync(dir, join(base, 'link'));

      const spellings = [dir, `${dir}/`, join(dir, '.'), join(dir, 'x', '..'), join(base, 'link')];
      const runs = await pool([...spellings, base], (s) => executeAsync([s]));
      const findings = (text: string): string =>
        locations(text)
          .map((l) => l.slice(l.lastIndexOf('/') + 1))
          .sort()
          .join('|');

      for (const [i, s] of spellings.entries()) {
        expect([s, runs[i].status]).toEqual([s, runs[0].status]);
        expect(findings(runs[i].stderr), s).toBe(findings(runs[0].stderr));
      }
      expect(findings(runs[0].stderr)).toContain('w.ts:');

      const wider = findings(runs[spellings.length].stderr).split('|');
      expect(findings(runs[0].stderr).split('|').filter((f) => !wider.includes(f))).toEqual([]);
    },
    BUDGET,
  );
});

// KNOWN OPEN DEFECT, filed separately — do NOT unskip here. `if (!source) continue;` at script line
// ~190 drops a file the compiler could not read or could not parse, and the run then exits 0 over a
// tree it never looked at. Both shapes are measured on be2f3f1:
//   - a source file written with mode 0o000 → "0 executors, 0 inspected", empty stderr, exit 0
//   - one stray backtick (`const s = ` + "`oops") above a wedge → the same green
// The body below is the assertion that should hold once the issue is fixed; it is skipped rather
// than committed red, because a red test on this branch blocks the merge and this defect predates
// #76. Unskip in the commit that fixes it.
describe.skip('assert-executor-safety: files the compiler could not read (KNOWN OPEN DEFECT)', () => {
  it('refuses a tree holding a source file it could not read', async () => {
    const dir = join(tempdir('exec-open-'), 'src');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'server.ts'), '// mark\n');
    writeFileSync(join(dir, 'w.ts'), WEDGE, { mode: 0o000 });
    expect((await executeAsync([dir])).status).toBe(1);
  });

  it('refuses a tree holding a source file it could not parse', async () => {
    const dir = join(tempdir('exec-open-'), 'src');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'server.ts'), '// mark\n');
    writeFileSync(join(dir, 'hidden.ts'), `const s = \`oops\n${WEDGE}`);
    expect((await executeAsync([dir])).status).toBe(1);
  });
});
