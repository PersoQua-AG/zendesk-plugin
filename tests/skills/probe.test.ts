// tests/skills/probe.test.ts
import { describe, it, expect } from 'vitest';
import { boot, probeMethods, writesIn } from './probe.js';

// The read-only verdicts in this suite are only worth something if the probe really drives every
// tool to Zendesk and really sees a write when one happens. Both are checked here, not assumed.
describe('skill-eval probe', () => {
  it('drives every registered tool to at least one Zendesk request, except the local cache replay', async () => {
    const b = await boot();
    const names = [...(await b.schemas()).keys()];
    await b.close();
    const methods = await probeMethods(names);
    expect(names.length).toBeGreaterThan(60);
    expect(Object.keys(methods).filter((n) => methods[n].length === 0)).toEqual(['zendesk_query']);
  });

  it('sees the write of a write tool', async () => {
    const methods = await probeMethods(['zendesk_update_ticket', 'zendesk_add_comment', 'zendesk_get_ticket']);
    expect(writesIn(methods)).toEqual(['zendesk_update_ticket: PUT', 'zendesk_add_comment: PUT']);
  });
});
