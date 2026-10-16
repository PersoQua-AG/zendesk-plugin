// tests/skills/recorded.test.ts
// Structure of the recorded instruction-following cases (S0 classes I, the I halves of M, and U).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { boot, filesIn, read, recordedCases, root, skillNames, toolsNamedIn } from './probe.js';

const cases = recordedCases();

describe('recorded skill cases', () => {
  it.each(cases.map((c) => [c.file, c] as const))('%s is well-formed', (file, c) => {
    expect(file).toBe(`tests/skills/fixtures/${c.skill}/${c.id.toLowerCase()}.json`);
    expect(c.id).toBe(`${c.row}-${c.role}`);
    expect(['happy', 'failcheck']).toContain(c.role);
    expect(['recorded', 'unenforced', 'pending-owner-decision']).toContain(c.status);
    expect(typeof c.input.prompt).toBe('string');
    // `expected` is prose for whoever grades a run; CI cannot judge prose, so only what it names is checked below.
    expect(typeof c.expected === 'string' && c.expected.trim(), `${c.id}: expected is not a non-blank string`).toBeTruthy();
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

  it('every tool, command, file, section, skill, subagent and identifier an expected names exists and is cited; a case naming none is `unchecked`', async () => {
    const b = await boot();
    const tools = await b.schemas().finally(() => b.close());
    const ref = (r: string, ok: boolean): [string, boolean] => [r, ok];
    const wrong = cases.flatMap((c) => {
      const said = String(c.expected ?? ''); // a missing or non-string field is the well-formed case's red, not a TypeError here
      const files = c.source.map((s) => s.file);
      const cited = [...new Set(files)].filter((f) => existsSync(join(root, f))).map(read).join('\n');
      const citedLines = c.source.filter((s) => existsSync(join(root, s.file))).map((s) => read(s.file).split('\n')[s.line - 1]).join('\n');
      const quotedTools = toolsNamedIn(c.source.map((s) => s.quote).join('\n'));
      const skill = `skills/${c.skill}/SKILL.md`;
      const refs = [
        ...toolsNamedIn(said).map((t) => ref(t, tools.has(t) && quotedTools.includes(t))),
        ...[...said.matchAll(/\/zendesk:([\w-]+)/gi)].map(([, n]) => ref(`commands/${n}.md`, files.includes(`commands/${n}.md`))),
        ...(said.match(/(?:\.?[\w-]+\/)+[\w.-]+\.(?:ts|mjs|js|md|json|ya?ml)\b/g) ?? []).map((f) => ref(f, files.includes(f))),
        ...[...said.matchAll(/SKILL\.md "([^"]+)"/g)].map(([, h]) => ref(`${skill} ## ${h}`, c.source.some((s) => s.file === skill && s.quote === `## ${h}`))),
        // a hyphenated adjective before skill/subagent ("this read-only skill") is read as a name and goes red; reword it.
        ...[...said.matchAll(/\b([a-z0-9]+(?:-[a-z0-9]+)+)`? (skill|subagent)s?\b/gi)].map(([, n, k]) =>
          ref(`${k} ${n}`, cited.includes(n) && (k.toLowerCase() === 'skill' ? skillNames().includes(n) : filesIn('agents', '.md').includes(`agents/${n}.md`))),
        ),
        // ponytail: camelCase only; a lowercase or PascalCase identifier stays prose for the grader.
        ...[...new Set(said.match(/\b[a-z]+[A-Z]\w*/g))].map((id) => ref(`identifier ${id}`, new RegExp(`\\b${id}\\b`).test(citedLines))),
      ];
      const declared =
        refs.length === 0
          ? c.unchecked !== true ? ['names nothing checkable and is not marked `unchecked: true`'] : said.trim().length > 20 ? [] : ['is `unchecked` and has under 21 characters of expected']
          : c.unchecked === undefined ? [] : ['names something yet is marked `unchecked`'];
      return [...refs.filter(([, ok]) => !ok).map(([r]) => `${r} does not exist or is not cited`), ...declared].map((p) => `${c.id}: ${p}`);
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
