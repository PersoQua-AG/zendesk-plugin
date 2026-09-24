// tests/skills/inventory.test.ts
// INV-1: the skill, command and agent files on disk are exactly the files the recorded cases cover,
// so adding, renaming or removing one fails until its evals follow (claude-layer only checks existence).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { recordedCases, root } from './probe.js';

const LAYER = ['skills', 'commands', 'agents'];

const onDisk = (): string[] =>
  LAYER.flatMap((dir) =>
    existsSync(join(root, dir))
      ? readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith('.md'))
          .map((e) => join(e.parentPath, e.name).slice(root.length + 1))
      : [],
  ).sort();

describe('skill inventory', () => {
  it('INV-1 failcheck: skill, command and agent files on disk equal the files the evals cite', () => {
    const covered = [...new Set(recordedCases().flatMap((c) => c.source.map((s) => s.split(':')[0])))]
      .filter((f) => LAYER.includes(f.split('/')[0]))
      .sort();
    expect(onDisk()).toEqual(covered);
  });

  it('INV-1 failcheck: every fixture folder names a skill on disk, or the commands group', () => {
    const skills = readdirSync(join(root, 'skills'));
    const orphans = [...new Set(recordedCases().map((c) => c.skill))].filter((s) => s !== 'commands' && !skills.includes(s));
    expect(orphans).toEqual([]);
  });
});
