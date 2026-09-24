// tests/skills/recorded.test.ts
// Structure of the recorded instruction-following cases (S0 classes I, the I halves of M, and U).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { read, recordedCases, root } from './probe.js';

const cases = recordedCases();
const skills = readdirSync(join(root, 'skills'));

describe('recorded skill cases', () => {
  it.each(cases.map((c) => [c.file, c] as const))('%s is well-formed', (file, c) => {
    expect(file).toBe(`tests/skills/fixtures/${c.skill}/${c.id.toLowerCase()}.json`);
    expect(c.id).toBe(`${c.row}-${c.role}`);
    expect(['happy', 'failcheck']).toContain(c.role);
    expect(c.ci).toBe('structure-only');
    expect(c.kind === 'instruction-following' ? ['recorded'] : ['unenforced', 'pending-owner-decision']).toContain(c.status);
    expect(typeof c.input.prompt).toBe('string');
    expect(c.expected.length).toBeGreaterThan(20);
    expect(c.source.length).toBeGreaterThan(0);
  });

  it('every cited file:line exists and is not blank', () => {
    const broken: string[] = [];
    for (const c of cases) {
      for (const ref of c.source) {
        const [file, line] = ref.split(':');
        const text = existsSync(join(root, file)) ? read(file).split('\n')[Number(line) - 1] : undefined;
        if (!text?.trim()) broken.push(`${c.id}: ${ref}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every skill has at least one happy and one failcheck instruction-following case', () => {
    const missing = skills.flatMap((s) =>
      (['happy', 'failcheck'] as const)
        .filter((role) => !cases.some((c) => c.skill === s && c.role === role && c.kind === 'instruction-following'))
        .map((role) => `${s}: ${role}`),
    );
    expect(missing).toEqual([]);
  });
});
