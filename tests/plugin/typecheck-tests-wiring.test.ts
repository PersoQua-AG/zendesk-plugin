import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CI = join(root, '.github', 'workflows', 'ci.yml');

// #57. The check itself is `tsc`, which needs no test. What needs one is its WIRING, because every
// part of it fails silently: a tsconfig that lists four folders type-checks four folders and says
// nothing about the rest, and a script nobody runs in CI rots on the integration branch exactly the
// way this one did between PR #39 and here. Deleting any single line below leaves the whole suite
// green, which is why these assertions exist at all.
describe('the test type-check is wired, and over all of tests/ (#57)', () => {
  it('runs as a CI step, in the job that has the dev toolchain installed', () => {
    const ci = readFileSync(CI, 'utf8');
    expect(ci).toContain('npm run typecheck:tests');
    // After `npm ci`: tsc is not installed before it, so a step above the install cannot run.
    expect(ci.indexOf('npm run typecheck:tests')).toBeGreaterThan(ci.indexOf('- run: npm ci'));
  });

  it('is a package script, so CI and a developer run the same command', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['typecheck:tests']).toBe('tsc -p tests/tsconfig.json');
  });

  // The curated `include` is the defect #57 removes: a type error in a folder nobody added was
  // invisible to this command AND to `npm run build`, whose tsconfig sees src/ alone.
  it('includes all of tests/, not a list of folders someone has to remember to extend', () => {
    const text = readFileSync(join(root, 'tests', 'tsconfig.json'), 'utf8');
    const include: string[] = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')).include;
    expect(include).toContain('.');
    expect(include.filter((i) => !i.startsWith('..'))).toEqual(['.']);
  });

  // The whole claim, end to end: a type error planted in a folder that the old curated list did
  // not name makes the real command exit non-zero. tests/tools/ is one of the folders #57 names.
  //
  // Run on a copy outside the repository: a probe in the live tests/tools is a file that appears and
  // vanishes under every suite that walks tests/ in the same run, and the bound-port guard exits 2
  // on a file it listed and could not read. The copy is both tsconfigs byte for byte, so `include`
  // resolves exactly as it does in the repo, and the probe is the only file it can find.
  it('a type error in a folder the old list never named fails the command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typecheck-wiring-'));
    try {
      mkdirSync(join(dir, 'tests', 'tools'), { recursive: true });
      copyFileSync(join(root, 'tsconfig.json'), join(dir, 'tsconfig.json'));
      copyFileSync(join(root, 'tests', 'tsconfig.json'), join(dir, 'tests', 'tsconfig.json'));
      // NOT a dot-prefixed name: tsc's include globs skip those, so a `.probe.ts` would be absent
      // from both runs and the ablation below would pass without proving anything.
      writeFileSync(join(dir, 'tests', 'tools', 'zz-typecheck-probe.ts'), 'export const probe: number = "not a number";\n');
      const run = spawnSync('npx', ['tsc', '-p', join(dir, 'tests', 'tsconfig.json')], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(run.status).not.toBe(0);
      // A list that misses tools/ finds no input in the copy and answers TS18003 instead.
      expect(run.stdout).toContain('TS2322');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
