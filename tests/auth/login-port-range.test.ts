import { describe, it, expect } from 'vitest';
import { runLogin } from '../../src/tools/login.js';
import { CALLBACK_PORT_RULE } from '../../src/auth/config.js';
import { deps, settlesWithin, setupLoginHarness } from './login-harness.js';

setupLoginHarness('login-port-range-');

// resolveAuthConfig rejects such a port at startup, so the extension normally never reaches here.
// The CLI, the remote path and a future caller can still hand one in, and then the bind fails
// SYNCHRONOUSLY — the one failure shape that used to leave the outer promise pending forever.
describe('zendesk_login with an unusable callback port', () => {
  it('answers with the field to fix instead of hanging', async () => {
    const text = await settlesWithin('runLogin(70000)', runLogin(deps(70_000)));

    // The rule's wording lives in CALLBACK_PORT_RULE and is asserted verbatim once, in
    // oauth-flow.bind-liveness.test.ts. Handwriting it a second time here pins a sentence; what
    // this case is about is that the sentence reaches the MCP boundary intact.
    expect(text).toBe(
      `Zendesk login failed: OAuth callback server could not start on port 70000 (${CALLBACK_PORT_RULE}). ` +
        'Run zendesk_login again once that is resolved.',
    );
    // NOT subsumed by the toBe() above, measured rather than assumed (#94). That assertion
    // INTERPOLATES CALLBACK_PORT_RULE, so it pins the frame around the rule and never the rule's
    // own wording: swap the constant and expected moves with actual. These four read the finished
    // text instead, and each is red on its own line against its own ablation of the constant: the
    // field check on a rule that stops naming the field, the secret guard on one carrying the
    // secret, the path guard on one carrying a path. The line-count check needs one ablation more
    // — the first-line truncation in failureText (src/tools/login.ts) — because that truncation is
    // what keeps a multi-line rule from reaching the boundary today. No line numbers here on
    // purpose: this comment has already outlived one renumbering of the file (#89).
    expect(text).toContain('oauth_callback_port');
    // MCP presentation rules: one line, no path, no secret.
    expect(text.split('\n')).toHaveLength(1);
    expect(text).not.toContain('secret-xyz');
    expect(text).not.toMatch(/tokens\.enc|\/(?:var|tmp|Users)\//);
  });
});
