import { describe, it, expect } from 'vitest';
import { runLogin } from '../../src/tools/login.js';
import { CALLBACK_PORT_RULE } from '../../src/auth/config.js';
import { deps, freePort, rebind, settlesWithin, setupLoginHarness } from './login-harness.js';

setupLoginHarness('login-port-range-');

// resolveAuthConfig rejects such a port at startup, so the extension normally never reaches here.
// The CLI, the remote path and a future caller can still hand one in, and then the bind fails
// SYNCHRONOUSLY — the one failure shape that used to leave the outer promise pending forever.
describe('zendesk_login with an unusable callback port', () => {
  it('answers with the field to fix instead of hanging', async () => {
    const text = await settlesWithin('runLogin(70000)', runLogin(deps(70_000)));

    // The rule's wording lives in CALLBACK_PORT_RULE and is asserted verbatim once, in
    // tests/auth/oauth-flow.port-range.test.ts. Handwriting it a third time here pins a sentence;
    // what this case is about is that the sentence reaches the MCP boundary intact.
    expect(text).toBe(
      `Zendesk login failed: OAuth callback server could not start on port 70000 (${CALLBACK_PORT_RULE}). ` +
        'Run zendesk_login again once that is resolved.',
    );
    expect(text).toContain('oauth_callback_port');
    // MCP presentation rules: one line, no stack, no path, no secret.
    expect(text.split('\n')).toHaveLength(1);
    expect(text).not.toMatch(/\bat \S+:\d+|node:internal|RangeError/);
    expect(text).not.toContain('secret-xyz');
    expect(text).not.toMatch(/tokens\.enc|\/(?:var|tmp|Users)\//);
  });

  it('promises no authorization URL, because nothing was bound', async () => {
    const text = await settlesWithin('runLogin(65536)', runLogin(deps(65_536)));
    expect(text).not.toContain('https://');
    expect(text).toContain('oauth_callback_port');
  });

  // THE actual damage. runLogin serialises every call on one queue, so a call that never settles
  // wedges every zendesk_login after it — no message, no timeout, restart-only. This pins that the
  // bad port costs exactly one call and nothing more.
  it('leaves the login queue usable — the very next zendesk_login starts a flow normally', async () => {
    const failed = await settlesWithin('runLogin(70000)', runLogin(deps(70_000)));
    expect(failed).toContain('oauth_callback_port');

    const port = await freePort();
    const text = await settlesWithin(
      'the next runLogin',
      runLogin(deps(port, { callbackTimeoutMs: 60_000 })),
    );
    expect(text).toMatch(/authorization started/i);
    expect(text).toContain(`https://acme.zendesk.com/oauth/authorizations/new`);
    expect(text).toContain(encodeURIComponent(`http://localhost:${port}/callback`));
  });

  // A failed bind must not leave a half-open server behind on a port that WAS usable: the failing
  // call is followed by a plain bind on a free port, which the previous case already covers, and
  // here by proof that the failing call itself left nothing listening anywhere it could reach.
  it('leaves nothing listening after the failed bind', async () => {
    const port = await freePort();
    await settlesWithin('runLogin(-1)', runLogin(deps(-1)));
    await rebind(port);
  });
});
