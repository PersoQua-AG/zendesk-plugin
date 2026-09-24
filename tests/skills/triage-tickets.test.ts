// tests/skills/triage-tickets.test.ts
// Deterministic half of skills/triage-tickets/SKILL.md (S0 rows TR-1, TR-3).
import { describe, it, expect } from 'vitest';
import { probeMethods, read, toolsNamedIn, writesIn } from './probe.js';

const SKILL = 'skills/triage-tickets/SKILL.md';

describe('triage-tickets: read-only (SKILL.md:3,8)', () => {
  // The tool set is read from the skill text, so a write tool added to the skill turns this red.
  it('TR-1/TR-3 failcheck: every tool the skill names issues only GET requests', async () => {
    const tools = toolsNamedIn(read(SKILL));
    expect(tools).toContain('zendesk_execute_view');
    expect(writesIn(await probeMethods(tools))).toEqual([]);
  });
});
