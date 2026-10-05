// tests/skills/probe.test.ts
import { beforeAll, describe, it, expect } from 'vitest';
import { WRITES, probeRequests, writesIn } from './probe.js';

// The read-only verdicts in this suite are only worth something if the probe really drives every
// tool to Zendesk and really sees every write. Both are checked here, not assumed.
describe('skill-eval probe', () => {
  let requests: Record<string, string[]>;
  beforeAll(async () => {
    requests = await probeRequests();
  });

  it('drives every registered tool to at least one Zendesk request, except the local cache replay', () => {
    expect(Object.keys(requests).filter((n) => requests[n].length === 0)).toEqual(['zendesk_query']);
  });

  it('sees exactly the known write tools and their writes', () => {
    expect(writesIn(requests).sort()).toEqual([...WRITES].sort());
  });
});
