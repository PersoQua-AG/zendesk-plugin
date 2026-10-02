// Property-based tests for scripts/assert-executor-safety.mjs — the generator, the shrinker and the
// PRNG live in ./executor-guard-property.mjs; this file only states the properties.
//
// WHY PROPERTIES AND NOT MORE FIXTURES. executor-safety-guard.test.ts pins the WALK with hand-built
// sources, one verdict per fixture. What no fixture reaches is the product of the two surfaces the
// caller actually controls after #76: how the scan root is SPELLED and what the mark on disk IS.
// That product is ~360 shapes before file contents, so it is generated, and every case here is a
// real run of the real script over a real tree.
//
// ONLY PROPERTIES THAT HOLD ON THIS REVISION ARE ASSERTED HERE. Four more were generated and FAIL
// on this revision; they are reported as defects rather than committed red, and each is named at the
// bottom of this file so the next round does not re-derive them.
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, execute, locations, WEDGE } from './executor-guard-property.mjs';

// Fixed seeds, not Date.now(): a property that only sometimes covers its space is a property that
// only sometimes catches a regression, and a red run has to be replayable from the seed printed here.
const SEEDS = [1, 2, 3];
const CASES = 24;
const BUDGET = 180_000;

// `check` returns null when every generated case held, and the SHRUNK counterexample otherwise.
function hold(property: Parameters<typeof check>[0]): void {
  for (const seed of SEEDS) {
    const bad = check(property, { seed, n: CASES });
    expect(
      bad,
      bad ? `seed=${seed} shrunk=${JSON.stringify(bad.minimal)}\n${bad.message}` : '',
    ).toBeNull();
  }
}

const assert = (ok: unknown, message: string): void => {
  if (!ok) throw new Error(message);
};

describe('assert-executor-safety: generated properties', () => {
  // All three invariants are checked in ONE pass over the generated cases, not one pass each: every
  // case costs a process spawn, and three passes over the same 72 trees would triple the suite's
  // slowest file to buy nothing. A failure still names which invariant broke.
  it(
    'holds every invariant over 72 generated trees (seeds 1-3)',
    () =>
      hold((c, r, m) => {
        // I1 — the process always reaches its own exit, over every argv and every tree shape.
        assert(r.signal == null, `I1: killed by ${r.signal}`);
        assert(r.status === 0 || r.status === 1, `I1: status ${r.status}`);

        // I2 — exit 0 never coexists with a named problem.
        if (r.status === 0) {
          assert(!/Refusing the tree/.test(r.stderr), 'I2: exit 0 with problems reported');
          assert(locations(r.stderr).length === 0, `I2: exit 0 with findings: ${locations(r.stderr)}`);
        }

        // I4 — any number of roots but one is refused in words, never half-honoured. Generated
        // because the arity and the spelling interact: an empty string is one argv entry.
        if (c.roots !== 1) {
          assert(r.status === 1, `I4: ${c.roots} roots accepted with status ${r.status}`);
          assert(
            /Expected exactly one scan root/.test(r.stderr),
            `I4: ${c.roots} roots, no refusal:\n${r.stderr.slice(0, 200)}`,
          );
        }

        // I3 — the one thing a guard may not do: lose a wedge in the tree it was told to scan. The
        // precondition is that a scan happened at all; a run refused for its argv is a refusal, not
        // a lost finding, and the cases below cover those.
        if (m.scanned == null || c.roots !== 1 || c.emptyArg) return;
        const reachable = c.files.filter((f) => f.wedge && f.ext !== '.d.ts');
        if (reachable.length === 0) return;
        assert(/server\.listen\(port\)/.test(r.stderr), `I3: wedge unreported: ${JSON.stringify(c.files)}`);
        assert(r.status === 1, `I3: wedge present but status ${r.status}`);
      }),
    BUDGET,
  );
});

describe('assert-executor-safety: the scan root the caller spells', () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tree = (): string => {
    const base = mkdtempSync(join(tmpdir(), 'exec-prop-root-'));
    temps.push(base);
    const dir = join(base, 'src');
    mkdirSync(join(dir, 'deep'), { recursive: true });
    writeFileSync(join(dir, 'server.ts'), '// mark\n');
    writeFileSync(join(dir, 'deep', 'w.ts'), WEDGE);
    return dir;
  };
  const findings = (text: string): string[] =>
    locations(text)
      .map((l) => l.slice(l.lastIndexOf('/') + 1))
      .sort();

  it('names the same finding however the same directory is spelled', () => {
    const dir = tree();
    const link = join(dir, '..', 'link');
    symlinkSync(dir, link);
    const spellings = [dir, `${dir}/`, join(dir, '.'), join(dir, 'x', '..'), link];
    const runs = spellings.map((s) => {
      const r = execute([s]);
      return { s, status: r.status, findings: findings(r.stderr).join('|') };
    });
    for (const r of runs) {
      expect([r.s, r.status], r.s).toEqual([r.s, runs[0].status]);
      expect(r.findings, r.s).toBe(runs[0].findings);
    }
    expect(runs[0].findings).toContain('w.ts:');
  });

  it('loses no finding when the caller names a wider root than the guarded one', () => {
    // A too-wide root is the misedit the script header calls harmless BECAUSE the walk is
    // recursive. Harmless only holds if nothing drops out, so it is checked rather than asserted.
    const dir = tree();
    const child = findings(execute([dir]).stderr);
    const parent = findings(execute([join(dir, '..')]).stderr);
    expect(child.length).toBeGreaterThan(0);
    expect(child.filter((f) => !parent.includes(f))).toEqual([]);
  });

  it('treats the mark as a mark only where the mark is a readable source file', () => {
    // Pins the HALF that holds on this revision: a DANGLING server.ts symlink does not mark the
    // tree. The directory, wrong-case and symlink-to-outside spellings DO mark it today, which is
    // reported as a defect; this case is the one that already behaves.
    const base = mkdtempSync(join(tmpdir(), 'exec-prop-mark-'));
    temps.push(base);
    const dir = join(base, 'src');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(base, 'gone.ts'), join(dir, 'server.ts'));
    expect(existsSync(join(dir, 'server.ts'))).toBe(false);
    expect(lstatSync(join(dir, 'server.ts')).isSymbolicLink()).toBe(true);
    const r = execute([dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Not the guarded tree');
  });

  it('refuses an empty scan root instead of resolving it to the repository root', () => {
    // `resolve(root, '')` is the repo root, so an empty argument makes the guard walk node_modules.
    // It cannot exit 0 there — the repo root carries no server.ts — so what is pinned is the
    // documented consequence, not a clean refusal, which this revision does not give.
    const r = execute(['']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Not the guarded tree');
    expect(r.stderr).toMatch(/node_modules/);
  });

});

// Generated and FAILING on this revision — reported as defects, deliberately not pinned here:
//   1. a scan root that is a FILE crashes with a raw ENOTDIR stack trace (script line 106)
//   2. exit 0 does not imply a real mark: a DIRECTORY named server.ts, a `Server.ts` on a
//      case-insensitive filesystem, and a symlink to a file outside the tree all mark it (line 297)
//   3. a non-zero exit does not keep stdout clean: a marked tree with findings prints the whole
//      inventory to stdout and exits 1, against the policy stated at line 299 (line 302)
//   4. a source file the compiler cannot read or cannot parse is dropped in silence (line 190)
