// tests/plugin/claude-layer.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));
}

function registeredTools(): Set<string> {
  const dir = join(root, 'src', 'register');
  const names = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/registerTool\(\s*'(zendesk_[a-z0-9_]+)'/g)) names.add(m[1]);
  }
  return names;
}

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

const contentFiles = [
  ...walk(join(root, 'skills')),
  ...walk(join(root, 'commands')),
  ...walk(join(root, 'agents')),
];

const EXPECTED = [
  'skills/ticket-manager/SKILL.md',
  'skills/data-analyst/SKILL.md',
  'skills/o365-bridge/SKILL.md',
  'skills/triage-tickets/SKILL.md',
  'skills/guide-authoring/SKILL.md',
  'commands/tickets.md',
  'commands/ticket.md',
  'commands/report.md',
  'commands/search.md',
  'commands/escalate.md',
  'agents/support-agent.md',
];

describe('M7 Claude layer', () => {
  // 64 Zendesk data/action tools + zendesk_login. The stdio tool surface is deliberately extended
  // by exactly one tool so a Desktop user, who has no terminal for `npm run authorize`, can log in.
  it('registers exactly 65 zendesk tools', () => {
    expect(registeredTools().size).toBe(65);
  });

  it('every expected skill/command/agent file exists', () => {
    for (const rel of EXPECTED) expect(existsSync(join(root, rel)), rel).toBe(true);
  });

  it('every zendesk_* tool referenced in content is a registered tool', () => {
    const registered = registeredTools();
    const unknown: string[] = [];
    for (const f of contentFiles) {
      const text = readFileSync(f, 'utf8');
      // Include digits so a digit-suffixed hallucination (e.g. `zendesk_report2`) is caught
      // rather than silently truncated to a real tool prefix (`zendesk_report`) that passes.
      for (const m of text.matchAll(/zendesk_[a-z0-9_]+/g)) {
        if (!registered.has(m[0])) unknown.push(`${f}: ${m[0]}`);
      }
    }
    expect(unknown, `unknown tools referenced:\n${unknown.join('\n')}`).toEqual([]);
  });

  it('skills declare name+description; commands declare description; agent declares name+description', () => {
    for (const f of contentFiles) {
      const fm = frontmatter(readFileSync(f, 'utf8'));
      if (f.includes('/skills/') || f.includes('/agents/')) {
        expect(fm.name, `${f} name`).toBeTruthy();
        expect(fm.description, `${f} description`).toBeTruthy();
      } else {
        expect(fm.description, `${f} description`).toBeTruthy();
      }
    }
  });
});
