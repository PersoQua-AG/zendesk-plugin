import { describe, it, expect } from 'vitest';
import { waitForAuthorizationCode } from '../../src/auth/oauth-flow.js';
import { freePort } from './login-harness.js';

describe('waitForAuthorizationCode uncovered branches', () => {
  it('rejects when the callback matches state but carries no code', async () => {
    const port = freePort();
    const pending = waitForAuthorizationCode(port, 'expected-state');
    const assertion = expect(pending).rejects.toThrow(/missing code/i);
    await fetch(`http://localhost:${port}/callback?state=expected-state`).catch(() => {});
    await assertion;
  });

  it('ignores non-/callback requests and keeps waiting for the real callback', async () => {
    const port = freePort();
    const pending = waitForAuthorizationCode(port, 'expected-state');
    // A stray probe (e.g. favicon) hits a non-callback path and must NOT resolve/reject.
    const probe = await fetch(`http://localhost:${port}/favicon.ico`).catch(() => null);
    expect(probe?.status).toBe(404);
    // The real callback then completes the flow.
    await fetch(`http://localhost:${port}/callback?code=c1&state=expected-state`).catch(() => {});
    const result = await pending;
    expect(result.code).toBe('c1');
  });
});
