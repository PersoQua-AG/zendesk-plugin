import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    // After `npm ci` and before the build: tsc is not there before the install, and a type error
    // in a test is a defect in the gate that should fail ahead of the slow steps.
    const after = ci.indexOf('npm run typecheck:tests');
    expect(after).toBeGreaterThan(ci.indexOf('- run: npm ci'));
    expect(after).toBeLessThan(ci.indexOf('- run: npm run build'));
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
  it('a type error in a folder the old list never named fails the command', () => {
    // NOT a dot-prefixed name: tsc's include globs skip those, so a `.probe.ts` would be absent
    // from both runs and the ablation below would pass without proving anything.
    const probe = join(root, 'tests', 'tools', `zz-typecheck-probe-${randomUUID()}.ts`);
    writeFileSync(probe, 'export const probe: number = "not a number";\n');
    try {
      const run = spawnSync('npx', ['tsc', '-p', join(root, 'tests', 'tsconfig.json')], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(run.status).not.toBe(0);
      expect(run.stdout).toContain('TS2322');
    } finally {
      rmSync(probe, { force: true });
    }
  }, 120_000);

  // And it is not vacuous: the same probe under the OLD curated include is invisible. The config is
  // copied rather than edited in place so a crash cannot leave the real one narrowed.
  it('ablated: under the curated include, that same error is not seen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typecheck-ablation-'));
    const probe = join(root, 'tests', 'tools', `zz-typecheck-probe-${randomUUID()}.ts`);
    const narrowed = join(root, 'tests', `zz-tsconfig-ablation-${randomUUID()}.json`);
    writeFileSync(probe, 'export const probe: number = "not a number";\n');
    writeFileSync(
      narrowed,
      JSON.stringify({
        extends: '../tsconfig.json',
        compilerOptions: { rootDir: '..', noEmit: true },
        include: ['../src', 'auth', 'setup', 'skills', '../vitest.config.ts'],
      }),
    );
    try {
      const run = spawnSync('npx', ['tsc', '-p', narrowed], { cwd: root, encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain('TS2322');
    } finally {
      rmSync(probe, { force: true });
      rmSync(narrowed, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
