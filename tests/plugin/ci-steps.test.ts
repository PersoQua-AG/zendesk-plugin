// tests/plugin/ci-steps.test.ts
// Subject: tests/setup/ci-steps.ts, the parsed view of ci.yml that four wiring cases rely on. Each
// fixture step below is a way a text search reads a gate as wired when GitHub would not run it.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ciSteps } from '../setup/ci-steps.js';

const WORKFLOW = `
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
  skipped:
    if: github.event_name == 'push'
    steps:
      - run: npm run gated
`;

describe('ciSteps reads the workflow as GitHub does, not as text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-steps-'));
  const path = join(dir, 'ci.yml');
  writeFileSync(path, WORKFLOW);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const at = (job: string, command: string) => ciSteps(job, command, path);

  it('finds a live step, in a `run: |` block too, at its position', () => {
    expect(at('build-test', 'npm ci')).toEqual([{ index: 0, conditions: [] }]);
    expect(at('build-test', 'npm run block')).toEqual([{ index: 1, conditions: [] }]);
  });

  it('finds no step for a YAML comment, a shell comment, an echo, or another job', () => {
    expect(at('build-test', 'npm run commented')).toEqual([]);
    expect(at('build-test', 'npm run moved')).toEqual([]);
  });

  it('names every condition that can keep a step from gating', () => {
    expect(at('build-test', 'npm run never')).toEqual([{ index: 2, conditions: [false] }]);
    expect(at('build-test', 'npm run tolerated')).toEqual([{ index: 3, conditions: ['continue-on-error'] }]);
    expect(at('skipped', 'npm run gated')).toEqual([{ index: 0, conditions: ["github.event_name == 'push'"] }]);
  });
});
