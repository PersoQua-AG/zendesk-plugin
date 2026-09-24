// tests/skills/commands.test.ts
// Deterministic backstops for commands/*.md (S0 rows CMD-1, CMD-2).
import { describe, it, expect } from 'vitest';
import { boot, read } from './probe.js';

describe('commands: an empty id or query never reaches Zendesk (ticket.md:8, search.md:8)', () => {
  it('CMD-1 failcheck: an empty search query is rejected by the schema', async () => {
    const b = await boot();
    const r = await b.call('zendesk_search', { query: '' });
    await b.close();
    expect(b.calls).toEqual([]);
    expect(r.isError).toBe(true);
  });

  it('CMD-1 failcheck: a missing or non-positive ticket id is rejected by the schema', async () => {
    const b = await boot();
    for (const args of [{}, { ticketId: 0 }]) expect((await b.call('zendesk_get_ticket', args)).isError).toBe(true);
    await b.close();
    expect(b.calls).toEqual([]);
  });
});

describe('commands: /escalate is user-invoked only (escalate.md:4)', () => {
  it('CMD-2 failcheck: escalate.md keeps disable-model-invocation: true in its frontmatter', () => {
    const front = read('commands/escalate.md').match(/^---\n([\s\S]*?)\n---/);
    expect(front?.[1]).toMatch(/^disable-model-invocation: true$/m);
  });
});
