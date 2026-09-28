// tests/skills/commands.test.ts
// Deterministic backstops for commands/*.md (S0 rows CMD-1, CMD-2).
import { describe, it, expect } from 'vitest';
import { once, read } from './probe.js';

describe('commands: an empty id or query never reaches Zendesk (ticket.md:8, search.md:8)', () => {
  it.each([
    ['zendesk_search', { query: '' }],
    ['zendesk_get_ticket', {}],
    ['zendesk_get_ticket', { ticketId: 0 }],
  ])('CMD-1 failcheck: %s %j is rejected by the schema', async (name, args) => {
    const r = await once(name, args);
    expect(r.calls).toEqual([]);
    expect(r.isError).toBe(true);
  });
});

describe('commands: /escalate is user-invoked only (escalate.md:4)', () => {
  it('CMD-2 failcheck: escalate.md keeps disable-model-invocation: true in its frontmatter', () => {
    const front = read('commands/escalate.md').match(/^---\n([\s\S]*?)\n---/);
    expect(front?.[1]).toMatch(/^disable-model-invocation: true$/m);
  });
});
