import { describe, it, expect, afterEach } from 'vitest';
import { startCallbackListener } from '../../src/auth/oauth-flow.js';
import { closeRawSockets, freePort, rawRequest, settlesWithin } from './login-harness.js';

// The invariant here is the same LIVENESS one oauth-flow.bind-liveness.test.ts pins for the bind,
// one layer further in: a request that reaches the bound callback listener must never take the
// PROCESS down. The listener runs inside the stdio MCP server, so an uncaught throw out of its
// 'request' handler is not a failed login — it is the extension disappearing mid-turn, with all 65
// tools, for as long as the five-minute authorization window is open on a port every local process
// can reach.
//
// Why no existing case could see it: every other suite drove the listener through fetch() (see
// login-harness.ts hitCallback/redirect), and fetch normalizes its target before it is written to
// the socket. Only a raw socket can put "//" on the request line — login-harness.ts rawRequest.
// Coverage could not see it either — the `new URL` line ran in every callback test and counted as
// covered; what was untested was its THROWING exit, which v8 statement coverage does not distinguish.
//
// Measured on node v22.23.1, `new URL(target, 'http://localhost:<port>')`:
//   "//", "///", "//%", "http://"  -> TypeError [ERR_INVALID_URL] (empty authority)
//   "/%", "*", "//foo"             -> parse fine
// so the table is exactly the four that throw. The last one is absolute-form, legal in HTTP/1.1.
const UNPARSEABLE_TARGETS: readonly string[] = ['//', '///', '//%', 'http://'];

afterEach(closeRawSockets);

describe('the callback listener survives a request target that is not a URL', () => {
  it.each(UNPARSEABLE_TARGETS)('answers 400 to `GET %s` instead of throwing out of the handler', async (target) => {
    const port = freePort();
    const listener = await startCallbackListener(port, 'state-abc', 60_000);
    // An uncaught throw from the 'request' handler reaches the process, not this test. Recorded
    // rather than left to vitest so the assertion names the defect instead of the suite dying.
    const uncaught: unknown[] = [];
    const record = (err: unknown): void => void uncaught.push(err);
    process.on('uncaughtException', record);
    try {
      const status = await settlesWithin(`GET ${target}`, rawRequest(port, target));
      expect(uncaught, `GET ${target} threw out of the request handler`).toEqual([]);
      expect(status).toMatch(/^HTTP\/1\.1 400\b/);
    } finally {
      process.off('uncaughtException', record);
      listener.close();
      await expect(listener.promise).rejects.toThrow(/closed/);
    }
  });

  // A stray local request is not the user's browser, so it must not consume the authorization the
  // user is in the middle of — the same rule the 404 path already follows for an unknown path.
  it('leaves the pending authorization usable, so the real callback still completes it', async () => {
    const port = freePort();
    const listener = await startCallbackListener(port, 'state-abc', 60_000);
    try {
      for (const target of UNPARSEABLE_TARGETS) {
        expect(await settlesWithin(`GET ${target}`, rawRequest(port, target))).toMatch(/^HTTP\/1\.1 400\b/);
      }
      // Unknown path, for contrast: already non-destructive, and pinned here beside the new case so
      // the two cannot drift apart.
      expect(await settlesWithin('GET /elsewhere', rawRequest(port, '/elsewhere'))).toMatch(/^HTTP\/1\.1 404\b/);

      await fetch(`http://localhost:${port}/callback?code=the-code&state=state-abc`);
      await expect(settlesWithin('the real callback', listener.promise)).resolves.toEqual({
        code: 'the-code',
        redirectUri: `http://localhost:${port}/callback`,
      });
    } finally {
      listener.close();
    }
  });
});
