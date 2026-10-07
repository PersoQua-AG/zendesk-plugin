// tests/tools/kpi-no-percent.test.ts
// #65: "KPIs: keine Prozente, nur Zahlen". The rule is not only about what the report RENDERS —
// every instruction surface that tells the model what to ask for is covered too, so a skill,
// command, MCP prompt or tool description cannot quietly re-introduce a percentage. The prompt
// and tool lists are read from the running server, never hard-coded, so a new surface is covered
// the moment it is registered.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { cleanupDirs, connect, fixtureEnv, textOf } from '../server/harness.js';

afterEach(cleanupDirs);

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PERCENT = /%|\bpercent/i;

// Every offending line is listed as `file:line: text`, so a failure names the site to fix.
function offendingLines(label: string, text: string): string[] {
  return text
    .split('\n')
    .map((line, i) => (PERCENT.test(line) ? `${label}:${i + 1}: ${line.trim()}` : null))
    .filter((l): l is string => l !== null);
}

function markdownFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f))
    .sort();
}

describe('KPI surfaces carry no percentage (#65)', () => {
  it('T6: no skill, command or agent file asks for a percentage', () => {
    const files = ['skills', 'commands', 'agents'].flatMap(markdownFiles);
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((f) => offendingLines(f, readFileSync(join(root, f), 'utf8')))).toEqual([]);
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

  it('T6: the data-analyst skill names the CSAT good, bad and rated counts', () => {
    const skill = readFileSync(join(root, 'skills/data-analyst/SKILL.md'), 'utf8');
    for (const word of ['good', 'bad', 'rated']) expect(skill).toMatch(new RegExp(`\\b${word}\\b`));
  });

  // T7: commands/report.md and the report MCP prompt must stay word-for-word aligned on the
  // headline-numbers sentence. tests/server/prompts-drift.test.ts pins the whole body; this pins
  // the one sentence #65 changed, so an edit to only one of the two is named here as well.
  it('T7: the headline-numbers sentence is identical in commands/report.md and the report prompt', async () => {
    const sentence = (text: string): string | undefined => text.match(/Present the headline numbers:[^.]*\./)?.[0];
    const fromFile = sentence(readFileSync(join(root, 'commands/report.md'), 'utf8'));
    const client = await connect(fixtureEnv());
    const fromPrompt = sentence(textOf(await client.getPrompt({ name: 'report', arguments: { range: 'x' } })));
    await client.close();
    expect(fromFile).toBeDefined();
    expect(fromPrompt).toBe(fromFile);
  });
});
