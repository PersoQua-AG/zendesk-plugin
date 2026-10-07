// tests/tools/kpi-no-percent.test.ts
// #65: "KPIs: keine Prozente, nur Zahlen". The rule is not only about what the report RENDERS —
// every instruction surface that tells the model what to ask for is covered too, so a skill,
// command, MCP prompt or tool description cannot quietly re-introduce a percentage. The prompt
// and tool lists are read from the running server, never hard-coded, so a new surface is covered
// the moment it is registered.
import { describe, it, expect, afterEach } from 'vitest';
import { cleanupDirs, connect, fixtureEnv, textOf } from '../server/harness.js';
import { filesIn, read } from '../skills/probe.js';

afterEach(cleanupDirs);

const PERCENT = /%|\bpercent/i;

// Every offending line is listed as `file:line: text`, so a failure names the site to fix.
function offendingLines(label: string, text: string): string[] {
  return text
    .split('\n')
    .map((line, i) => (PERCENT.test(line) ? `${label}:${i + 1}: ${line.trim()}` : null))
    .filter((l): l is string => l !== null);
}

describe('KPI surfaces carry no percentage (#65)', () => {
  it('T6: no skill, command or agent file asks for a percentage', () => {
    const files = ['skills', 'commands', 'agents'].flatMap((dir) => filesIn(dir, '.md'));
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((f) => offendingLines(f, read(f)))).toEqual([]);
  });

  it('T6: no registered MCP prompt body or description asks for a percentage', async () => {
    const client = await connect(fixtureEnv());
    const { prompts } = await client.listPrompts();
    expect(prompts.length).toBeGreaterThan(0);
    const offences: string[] = [];
    for (const p of prompts) {
      offences.push(...offendingLines(`prompt ${p.name} (description)`, p.description ?? ''));
      const arg = p.arguments?.[0]?.name ?? '';
      const body = textOf(await client.getPrompt({ name: p.name, arguments: arg ? { [arg]: 'x' } : {} }));
      offences.push(...offendingLines(`prompt ${p.name}`, body));
    }
    await client.close();
    expect(offences).toEqual([]);
  });

  it('T6: no registered tool description asks for a percentage', async () => {
    const client = await connect(fixtureEnv());
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const offences = tools.flatMap((t) => offendingLines(`tool ${t.name}`, t.description ?? ''));
    await client.close();
    expect(offences).toEqual([]);
  });

  // The BULLET, not the bare words: `/\bgood\b/` matches anywhere in a Markdown file and so says
  // almost nothing. This fails if the line stops naming the three counts or states a share instead.
  it('T6: the data-analyst skill asks for the CSAT counts on its CSAT bullet', () => {
    const bullet = read('skills/data-analyst/SKILL.md').split('\n').find((l) => /^- a \*\*CSAT\*\*/.test(l));
    expect(bullet).toMatch(/\*\*good\*\*, \*\*bad\*\* and \*\*rated\*\* counts \(rated = good \+ bad\)/);
    expect(bullet).not.toMatch(PERCENT);
  });
});
