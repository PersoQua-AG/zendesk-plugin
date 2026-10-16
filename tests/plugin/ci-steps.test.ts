// tests/plugin/ci-steps.test.ts
// Subject: tests/setup/ci-steps.ts, the parsed view of ci.yml that four wiring cases rely on. Each
// fixture step below is a way a text search reads a gate as wired when GitHub would not run it.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ciJobSteps, ciSteps, ciTriggers, ciUses } from '../setup/ci-steps.js';

const WORKFLOW = `
on:
  pull_request:
    types: [edited]
jobs:
  other:
    steps:
      - run: npm run moved
  build-test:
    steps:
      # - run: npm run commented
      # npm run moved
      - run: npm ci
      - run: |
          # npm run commented
          echo npm run commented
          npm run block
      - run: npm run never
        if: false
      - run: npm run tolerated
        continue-on-error: true
      - run: npm run spelled-out
        if: \${{ success() }}
        continue-on-error: \${{ false }}
      - run: |
          exit 0
          npm run dead
      - &shared
        run: npm run anchored
      - run: npm run reshelled
        shell: bash -c 'true' {0}
      - run: echo "$READ"
        env:
          READ: an input
          NODE_OPTIONS: --import=./exit0.mjs
      - run: npm run always
        if: \${{ true }}
      - uses: Actions/Checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        if: false
      - uses: [actions/checkout@v4]
      - run: npm run default-shell
        shell: bash -e {0}
  skipped:
    if: github.event_name == 'push'
    steps:
      - run: npm run gated
  soft:
    needs: skipped
    continue-on-error: true
    defaults:
      run:
        shell: sh
    steps:
      - run: npm run soft
      - *shared
      - uses: actions/checkout@v4
`;

const LAYERED = `
env:
  A: wf
  B: wf
  NODE_OPTIONS: x
defaults:
  run:
    shell: sh
jobs:
  j:
    env:
      A: job
      B: job
    steps:
      - run: echo "$A $B"
        env:
          A: step
`;

describe('ciSteps reads the workflow as GitHub does, not as text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-steps-'));
  const path = join(dir, 'ci.yml');
  writeFileSync(path, WORKFLOW);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const at = (job: string, command: string) => ciSteps(job, command, path);

  it('finds a live step, as a `run: |` block, through an alias, or with `if: success()`, `if: ${{ true }}`, `continue-on-error: ${{ false }}` and `shell: bash -e {0}`', () => {
    expect(at('build-test', 'npm ci')).toEqual([{ index: 0, conditions: [] }]);
    expect(at('build-test', 'npm run spelled-out')).toEqual([{ index: 4, conditions: [] }]);
    expect(at('soft', 'npm run anchored')).toEqual([{ index: 1, conditions: ['continue-on-error', 'shell: sh', 'needs: skipped'] }]);
    expect(at('build-test', 'npm run always')).toEqual([{ index: 9, conditions: [] }]);
    expect(at('build-test', 'npm run default-shell')).toEqual([{ index: 13, conditions: [] }]);
  });

  it('finds no step for a comment, an echo, a line of a script, or another job', () => {
    expect(at('build-test', 'npm run commented')).toEqual([]);
    expect(at('build-test', 'npm run block')).toEqual([]);
    expect(at('build-test', 'npm run dead')).toEqual([]);
    expect(at('build-test', 'npm run moved')).toEqual([]);
  });

  it('names every condition it reads that can keep a step from gating: if, continue-on-error, shell, needs, unread env', () => {
    expect(at('build-test', 'npm run never')).toEqual([{ index: 2, conditions: [false] }]);
    expect(at('build-test', 'npm run tolerated')).toEqual([{ index: 3, conditions: ['continue-on-error'] }]);
    expect(at('skipped', 'npm run gated')).toEqual([{ index: 0, conditions: ["github.event_name == 'push'"] }]);
    expect(at('soft', 'npm run soft')).toEqual([{ index: 0, conditions: ['continue-on-error', 'shell: sh', 'needs: skipped'] }]);
    expect(at('build-test', 'echo "$READ"')).toEqual([{ index: 8, conditions: ['env: NODE_OPTIONS'] }]);
    expect(at('build-test', 'npm run reshelled')).toEqual([{ index: 7, conditions: ["shell: bash -c 'true' {0}"] }]);
  });

  it('finds an action at any version and in any case, with its inputs and gates, and no `uses` that is not a string', () => {
    const uses = (job: string) =>
      ciUses(job, 'actions/checkout', path).map(({ index, step, conditions }) => ({ index, with: step.with, conditions }));
    expect(uses('build-test')).toEqual([
      { index: 10, with: { 'fetch-depth': 0 }, conditions: [] },
      { index: 11, with: undefined, conditions: [false] },
    ]);
    expect(uses('soft')).toEqual([{ index: 2, with: undefined, conditions: ['continue-on-error', 'shell: sh', 'needs: skipped'] }]);
  });

  it('layers env workflow, then job, then step, and reads the workflow default shell', () => {
    const layered = join(dir, 'layered.yml');
    writeFileSync(layered, LAYERED);
    const { env, conditions } = ciJobSteps('j', layered)[0];
    expect({ env, conditions }).toEqual({ env: { A: 'step', B: 'job', NODE_OPTIONS: 'x' }, conditions: ['shell: sh', 'env: NODE_OPTIONS'] });
  });

  it('reads the bare `on:` key that YAML 1.1 turns into true, and a quoted one', () => {
    expect(ciTriggers(path)).toEqual({ pull_request: { types: ['edited'] } });
    writeFileSync(join(dir, 'quoted.yml'), '"on": push\n');
    expect(ciTriggers(join(dir, 'quoted.yml'))).toBe('push');
  });
});
