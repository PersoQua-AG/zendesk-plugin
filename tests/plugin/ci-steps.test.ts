// tests/plugin/ci-steps.test.ts
// Subject: tests/setup/ci-steps.ts, the parsed view of ci.yml that four wiring cases rely on. Each
// fixture step below is a way a text search reads a gate as wired when GitHub would not run it.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ciSteps, ciTriggers } from '../setup/ci-steps.js';

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
      - run: |
          exit 0
          npm run dead
      - &shared
        run: npm run anchored
  skipped:
    if: github.event_name == 'push'
    steps:
      - run: npm run gated
  soft:
    continue-on-error: true
    steps:
      - run: npm run soft
      - *shared
`;

describe('ciSteps reads the workflow as GitHub does, not as text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-steps-'));
  const path = join(dir, 'ci.yml');
  writeFileSync(path, WORKFLOW);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const at = (job: string, command: string) => ciSteps(job, command, path);

  it('finds a live step, as a `run: |` block, through an alias, or with `if: success()`', () => {
    expect(at('build-test', 'npm ci')).toEqual([{ index: 0, conditions: [] }]);
    expect(at('build-test', 'npm run spelled-out')).toEqual([{ index: 4, conditions: [] }]);
    expect(at('soft', 'npm run anchored')).toEqual([{ index: 1, conditions: ['continue-on-error'] }]);
  });

  it('finds no step for a comment, an echo, a line of a script, or another job', () => {
    expect(at('build-test', 'npm run commented')).toEqual([]);
    expect(at('build-test', 'npm run block')).toEqual([]);
    expect(at('build-test', 'npm run dead')).toEqual([]);
    expect(at('build-test', 'npm run moved')).toEqual([]);
  });

  it('names every condition that can keep a step from gating, on the step or its job', () => {
    expect(at('build-test', 'npm run never')).toEqual([{ index: 2, conditions: [false] }]);
    expect(at('build-test', 'npm run tolerated')).toEqual([{ index: 3, conditions: ['continue-on-error'] }]);
    expect(at('skipped', 'npm run gated')).toEqual([{ index: 0, conditions: ["github.event_name == 'push'"] }]);
    expect(at('soft', 'npm run soft')).toEqual([{ index: 0, conditions: ['continue-on-error'] }]);
  });

  it('reads the bare `on:` key that YAML 1.1 turns into true', () => {
    expect(ciTriggers(path)).toEqual({ pull_request: { types: ['edited'] } });
  });
});
