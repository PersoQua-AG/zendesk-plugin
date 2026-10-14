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
    expect(typeof c.expected).toBe('string');
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

  it('every tool, command, file and SKILL.md section an expected names exists', async () => {
    const b = await boot();
    const tools = await b.schemas().finally(() => b.close());
    const refs = cases.flatMap((c) => {
      const skill = `skills/${c.skill}/SKILL.md`;
      const said = c.expected ?? ''; // a missing field is the well-formed case's red, not a TypeError here
      return [
        ...toolsNamedIn(said).map((t) => ({ kind: 'tool', ref: t, ok: tools.has(t) })),
        ...[...said.matchAll(/\/zendesk:([a-z-]+)/g)].map(([, n]) => ({ kind: 'command', ref: `commands/${n}.md`, ok: existsSync(join(root, 'commands', `${n}.md`)) })),
        ...(said.match(/\b(?:src|tests|skills|commands|agents)\/[\w./-]+\.(?:ts|md)\b/g) ?? []).map((f) => ({ kind: 'file', ref: f, ok: existsSync(join(root, f)) })),
        ...[...said.matchAll(/SKILL\.md "([^"]+)"/g)].map(([, h]) => ({
          kind: 'section',
          ref: `${skill} ## ${h}`,
          ok: existsSync(join(root, skill)) && read(skill).split('\n').includes(`## ${h}`),
        })),
      ].map((r) => ({ ...r, ref: `${c.id}: ${r.ref}` }));
    });
    // Each kind is named by at least one real case, so an extractor that stops matching goes red here, not silent.
    expect(new Set(refs.map((r) => r.kind))).toEqual(new Set(['tool', 'command', 'file', 'section']));
    expect(refs.filter((r) => !r.ok).map((r) => r.ref)).toEqual([]);
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
