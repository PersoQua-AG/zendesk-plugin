// #104: the bind failure stated a false reason and threw the real one away. The property this file
// holds is the pair — a RangeError keeps the port rule word for word, and anything else gets a
// sentence that says nothing it does not know — together with the assurance the old bluntness was
// bought with: nothing of node's own text, no stack frame and no absolute path reaches the message
// a caller reads at the MCP boundary.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Server } from 'node:http';
import { startCallbackListener } from '../../src/auth/oauth-flow.js';
import { MIN_CALLBACK_PORT } from '../../src/auth/config.js';
import { freePort, settlesWithin, setupLoginHarness } from './login-harness.js';

setupLoginHarness('login-bind-reason-');

// A synchronous throw from listen() that is NOT a RangeError. The real producer is PR #101's
// bind-time port guard, which patches this very method; standing in for it here keeps the case on
// this branch rather than on that one, and covers every other synchronous thrower equally.
function throwsOnListen(err: unknown): void {
  vi.spyOn(Server.prototype, 'listen').mockImplementation(() => {
    throw err;
  });
}

async function bindFailure(port: number): Promise<Error> {
  return (await settlesWithin(
    `startCallbackListener(${port})`,
    startCallbackListener(port, 'state', 5_000),
  ).catch((e: unknown) => e)) as Error;
}

describe('the reason a failed callback bind states', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the port rule, verbatim, for the RangeError it is true of', async () => {
    const err = await bindFailure(70_000);
    expect(err.message).toBe(
      'OAuth callback server could not start on port 70000 (extension configuration field ' +
        '"oauth_callback_port" must be a whole number between 1024 and 65535).',
    );
    expect(err.cause).toBeInstanceOf(RangeError);
  });

  it('does not claim the port is out of range for a throw that is not a RangeError', async () => {
    const port = freePort();
    throwsOnListen(new TypeError('a bind-time guard refused this call'));
    const err = await bindFailure(port);
    expect(err.message).toContain(`could not start on port ${port}`);
    // The sentence the measurement in PR #101 produced for an in-range port. It must be gone.
    expect(err.message).not.toContain('must be a whole number between');
    expect(err.message).toContain("not node's own port validation");
    expect(err.message).toContain('TypeError');
  });

  // THE SECOND FALSE REASON, which the first fix walked straight into. node's listen() throws
  // RangeError only outside 0-65535; CALLBACK_PORT_RULE is 1024-65535 and nothing range-checks
  // `port` before the call. So for a privileged port that threw something else, a message saying
  // "the port is inside the allowed range" is as false as the range rule it replaced. The message
  // may make no claim about the range in either direction.
  // TWO ROWS, the two ends: 0 is the one value listen() accepts and the configuration refuses, and
  // 1023 is the boundary. Nothing in the code under test distinguishes any port here — that is the
  // point of the fix — so a third row buys a spawn and no claim.
  it.each([0, 1023])('claims nothing about the range for port %i, which is outside the rule', async (port) => {
    // The parameter list carries the claim, so it is asserted: these are ports the rule forbids
    // and node's listen() accepts, which is the gap the false sentence lived in. Without this the
    // case stayed green with [2000, 30000, 65535] and pinned nothing about privileged ports.
    expect(port, 'this case is about ports the callback rule forbids').toBeLessThan(MIN_CALLBACK_PORT);
    throwsOnListen(new TypeError('a bind-time guard refused this call'));
    const err = await bindFailure(port);
    // THE WHOLE MESSAGE, not a list of forbidden wordings. "Makes no claim about the range in
    // either direction" is a claim about the SET of sentences this may be, so only the exact
    // sentence holds it: measured, appending " The port itself is in the permitted range." — false
    // for 0 and 1023, which is exactly this case's subject — kept all 1520 tests green, because
    // three negatives covered three wordings and the class has more. Same shape as the RangeError
    // case above, which has always been pinned this way.
    expect(err.message).toBe(
      `OAuth callback server could not start on port ${port}: listen() threw TypeError, which is` +
        ` not node's own port validation — that throws RangeError and is reported separately.`,
    );
  });

  it('attaches the original error as the cause instead of discarding it', async () => {
    const port = freePort();
    const original = new TypeError('a bind-time guard refused this call');
    throwsOnListen(original);
    expect((await bindFailure(port)).cause).toBe(original);
  });

  // AC4 — the property the blunt replacement bought and the fix may not spend. The planted error
  // carries every shape that must not come through: node's own EACCES wording, a node: frame and
  // an absolute path.
  it('leaks no node text, no stack frame and no absolute path', async () => {
    const port = freePort();
    const planted = new Error(
      `listen EACCES: permission denied 0.0.0.0:${port}\n` +
        '    at Server.setupListenHandle (node:net:1937:21)\n' +
        '    at /Users/someone/secret/path/server.js:1:1',
    );
    throwsOnListen(planted);
    const err = await bindFailure(port);
    expect(err.message).not.toMatch(/node:|permission denied|EACCES|\/Users\//);
    expect(err.message).not.toMatch(/^\s+at /m);
    expect(err.message.split('\n')).toHaveLength(1);
  });

  // A name is an identifier or it is not used. `name` is a writable property on any object, so a
  // thrown value carrying a path in it would otherwise reach the boundary through the one field
  // that is interpolated.
  it('does not interpolate a name that is not an error class name', async () => {
    const port = freePort();
    const disguised = new Error('x');
    disguised.name = '/Users/someone/secret/path';
    throwsOnListen(disguised);
    const err = await bindFailure(port);
    expect(err.message).not.toContain('/Users/');
    expect(err.message).toContain('threw an error, which');
  });

  // `name` is writable, so a long one is as much a leak as a wrong one: 200 000 characters reached
  // the boundary verbatim before the length bound went on the gate.
  it('does not interpolate a name longer than any real error class', async () => {
    const port = freePort();
    const shouting = new Error('x');
    shouting.name = `${'A'.repeat(200_000)}Error`;
    throwsOnListen(shouting);
    const err = await bindFailure(port);
    expect(err.message).toContain('threw an error, which');
    expect(err.message.length).toBeLessThan(400);
  });

  it('survives a thrown value that is not an Error at all', async () => {
    const port = freePort();
    throwsOnListen('a string, thrown');
    const err = await bindFailure(port);
    expect(err.message).toContain('threw an error, which');
    expect(err.cause).toBe('a string, thrown');
  });
});
