import { describe, it, expect } from 'vitest';
import { waitForAuthorizationCode } from '../../src/auth/oauth-flow.js';

describe('waitForAuthorizationCode uncovered branches', () => {
  it('rejects when the callback matches state but carries no code', async () => {
    const pending = waitForAuthorizationCode(18981, 'expected-state');
    const assertion = expect(pending).rejects.toThrow(/missing code/i);
    await fetch('http://localhost:18981/callback?state=expected-state').catch(() => {});
    await assertion;
  });

  it('ignores non-/callback requests and keeps waiting for the real callback', async () => {
    const pending = waitForAuthorizationCode(18982, 'expected-state');
    // A stray probe (e.g. favicon) hits a non-callback path and must NOT resolve/reject.
    const probe = await fetch('http://localhost:18982/favicon.ico').catch(() => null);
    expect(probe?.status).toBe(404);
    // The real callback then completes the flow.
    await fetch('http://localhost:18982/callback?code=c1&state=expected-state').catch(() => {});
    const result = await pending;
    expect(result.code).toBe('c1');
  });
});
