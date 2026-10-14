// tests/skills/recorded.test.ts
// Structure of the recorded instruction-following cases (S0 classes I, the I halves of M, and U).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { boot, read, recordedCases, root, skillNames, toolsNamedIn } from './probe.js';

const cases = recordedCases();

describe('recorded skill cases', () => {
  it.each(cases.map((c) => [c.file, c] as const))('%s is well-formed', (file, c) => {
    expect(file).toBe(`tests/skills/fixtures/${c.skill}/${c.id.toLowerCase()}.json`);
    expect(c.id).toBe(`${c.row}-${c.role}`);
    expect(['happy', 'failcheck']).toContain(c.role);
    expect(['recorded', 'unenforced', 'pending-owner-decision']).toContain(c.status);
    expect(typeof c.input.prompt).toBe('string');
    // `expected` is prose for whoever grades a run; CI cannot judge prose, so only what it names is checked below.
    expect(c.expected?.trim(), `${c.id}: expected is missing or blank`).toBeTruthy();
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

  it('every tool, command, file and section an expected names is cited by its own case; a case naming none says why', async () => {
    const b = await boot();
    const tools = await b.schemas().finally(() => b.close());
    const wrong = cases.flatMap((c) => {
      const said = c.expected ?? ''; // a missing field is the well-formed case's red, not a TypeError here
      const files = c.source.map((s) => s.file);
      const quotedTools = toolsNamedIn(c.source.map((s) => s.quote).join('\n'));
      const skill = `skills/${c.skill}/SKILL.md`;
      const refs: Array<[string, boolean]> = [
        ...toolsNamedIn(said).map((t): [string, boolean] => [t, tools.has(t) && quotedTools.includes(t)]),
        ...[...said.matchAll(/\/zendesk:([\w-]+)/gi)].map(([, n]): [string, boolean] => [`commands/${n}.md`, files.includes(`commands/${n}.md`)]),
        ...(said.match(/(?:\.?[\w-]+\/)+[\w.-]+\.(?:ts|mjs|js|md|json|ya?ml)\b/g) ?? []).map((f): [string, boolean] => [f, files.includes(f)]),
        ...[...said.matchAll(/SKILL\.md "([^"]+)"/g)].map(([, h]): [string, boolean] => [
          `${skill} ## ${h}`,
          c.source.some((s) => s.file === skill && s.quote === `## ${h}`),
        ]),
      ];
      const declared =
        refs.length === 0
          ? c.unchecked?.trim() ? [] : ['names nothing checkable and gives no `unchecked` reason']
          : c.unchecked === undefined ? [] : ['names something yet is marked `unchecked`'];
      return [...refs.filter(([, ok]) => !ok).map(([r]) => `${r} is not registered or not cited`), ...declared].map((p) => `${c.id}: ${p}`);
    });
    expect(wrong).toEqual([]);
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
