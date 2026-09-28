// tests/skills/inventory.test.ts
// INV-1: the skill, command and agent files on disk are exactly the files the recorded cases cover,
// so adding, renaming or removing one fails until its evals follow (claude-layer only checks existence).
import { describe, it, expect } from 'vitest';
import { filesIn, recordedCases, skillNames } from './probe.js';

const LAYER = ['skills', 'commands', 'agents'];

describe('skill inventory', () => {
  it('INV-1 failcheck: skill, command and agent files on disk equal the files the evals cite', () => {
    const covered = [...new Set(recordedCases().flatMap((c) => c.source.map((s) => s.file)))]
      .filter((f) => LAYER.includes(f.split('/')[0]))
      .sort();
    expect(LAYER.flatMap((dir) => filesIn(dir, '.md')).sort()).toEqual(covered);
  });

  it('INV-1 failcheck: every fixture folder names a skill on disk, or the commands group', () => {
    const skills = skillNames();
    const orphans = [...new Set(recordedCases().map((c) => c.skill))].filter((s) => s !== 'commands' && !skills.includes(s));
    expect(orphans).toEqual([]);
  });
});
