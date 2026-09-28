// tests/skills/recorded.test.ts
// Structure of the recorded instruction-following cases (S0 classes I, the I halves of M, and U).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { read, recordedCases, root, skillNames } from './probe.js';

const cases = recordedCases();

describe('recorded skill cases', () => {
  it.each(cases.map((c) => [c.file, c] as const))('%s is well-formed', (file, c) => {
    expect(file).toBe(`tests/skills/fixtures/${c.skill}/${c.id.toLowerCase()}.json`);
    expect(c.id).toBe(`${c.row}-${c.role}`);
    expect(['happy', 'failcheck']).toContain(c.role);
    expect(['recorded', 'unenforced', 'pending-owner-decision']).toContain(c.status);
    expect(typeof c.input.prompt).toBe('string');
    expect(c.expected.length).toBeGreaterThan(20);
    expect(c.source.length).toBeGreaterThan(0);
  });

  it('every citation quotes the text on its cited line', () => {
    const drifted: string[] = [];
    for (const c of cases) {
      for (const { file, line, quote } of c.source) {
        const text = existsSync(join(root, file)) ? read(file).split('\n')[line - 1] : undefined;
        if (!quote.trim() || !text?.includes(quote)) drifted.push(`${c.id}: ${file}:${line}`);
      }
    }
    expect(drifted).toEqual([]);
  });

  it('every skill has at least one happy and one failcheck instruction-following case', () => {
    const missing = skillNames().flatMap((s) =>
      (['happy', 'failcheck'] as const)
        .filter((role) => !cases.some((c) => c.skill === s && c.role === role && c.status === 'recorded'))
        .map((role) => `${s}: ${role}`),
    );
    expect(missing).toEqual([]);
  });
});
