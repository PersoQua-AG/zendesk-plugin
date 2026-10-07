// The runtime half of #23, pinned (#74). Its subject is the class the source scan in
// scripts/assert-no-bound-port-literals.mjs cannot see: a port that reaches listen() through a
// const, an expression or an option bag. Every case here binds through the REAL net.Server, so it
// is the shipped patch in tests/setup/no-fixed-bind-port.ts that answers, never a re-implementation
// of its rule.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { startCallbackListener } from '../../src/auth/oauth-flow.js';
import { freePort } from '../auth/login-harness.js';
import { allowForeignBind, swallowedRefusal, takeRefusals } from '../setup/acquired-ports.js';

// NOT a literal at the call site, by construction — that is the whole point. The source scan reads
// `listen(PORT)` and sees no number; the guard under test reads 18977. This is the very const the
// ticket names, tests/auth/token-request-timeout.test.ts:14, which the scan has always walked past.
const PORT = 18977;

const opened: Server[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) await new Promise<void>((done) => s.close(() => done()));
});

// Every refusal is also written to a register, so one that the code under test swallowed still
// fails the case (tests/setup/no-fixed-bind-port.ts). The cases BELOW provoke refusals on purpose
// and have already asserted on them, so they claim theirs — and the claim is itself an assertion:
// a case that expected a refusal and got none fails here rather than quietly passing.
function claimRefusal(): void {
  expect(takeRefusals()).toHaveLength(1);
}

function listening(server: Server): Promise<Server> {
  opened.push(server);
  return new Promise((bound, failed) => {
    server.on('error', failed);
    server.on('listening', () => bound(server));
  });
}

describe('a fixed bind port is refused when it is bound', () => {
  it('catches a port that reached listen() through a const, and names the port and the call site', () => {
    expect(() => createServer().listen(PORT)).toThrow(
      new RegExp(`Refusing to bind the fixed port ${PORT} at .*bind-time-port-guard\\.test\\.ts`),
    );
    claimRefusal();
  });

  // The classes the regex is documented as missing, one call each.
  //
  // MEASURED AGAINST `BIND_CALL` ITSELF, and it is the answer to #74's open question: the source
  // scan sees NONE of the shapes below. Not one. `18e3` and `0x4650` do not match `\d[\d_]*\b`
  // at all, the option bag and the numeric string never reach the pattern, and an expression is
  // only matched through its FIRST literal — which `17_000 + 1_000` has at the call site, so that
  // row is written split here the way this file's siblings are. An earlier version of this comment
  // claimed the scan saw "exactly one" of them and that the hex literal was "filtered out as port
  // 0"; both were wrong, and `qa-engineer` reproduced the regex against each shape to show it.
  //
  // So the two instruments are not redundant and the text scan stays — but not for the reason first
  // written. It earns its place by refusing a bind in a file nothing ever executes, which a runtime
  // guard by construction cannot, and by naming file and line at review time rather than at bind
  // time. On SPELLING it is strictly the weaker of the two.
  // ONE ROW PER BRANCH OF THE GUARD, not per spelling. `17_000 + 1_000`, `18e3` and `0x4650` all
  // reach the patched listen() as the number 18000 — the guard cannot tell them apart and does not
  // try; only the regex can, and the regex is pinned in bound-port-literals-guard.test.ts. Of the
  // string spellings `'0x4650'` is the one that fails a digits-only test (it binds 18000, measured,
  // while `/^\d+$/` read it as a unix socket path), so `'18002'` and `'1.8e4'` add nothing to it.
  it.each([
    ['a number no literal wrote', () => createServer().listen(18e3)],
    ['an option bag', () => createServer().listen({ port: 18_001 })],
    ['a string node coerces', () => createServer().listen('0x4650')],
  ])('catches %s too', (_label, bind) => {
    expect(bind).toThrow(/Refusing to bind the fixed port/);
    claimRefusal();
  });

  // SCENARIO 1 OF #74, ON THE PATH THAT MATTERS. The product's one real bind path wraps its
  // listen() in a catch-everything and replaces whatever came out with its own wording
  // (src/auth/oauth-flow.ts), so the refusal never reaches an assertion: measured on this branch,
  // the case reported PASSED while the process exited 1 and the refusal arrived as an unhandled
  // error. src/ is out of scope for #74, so the answer is on this side — every refusal is written
  // to a register and an afterEach fails the case unless it was claimed.
  it('survives a product that catches everything around its own listen()', async () => {
    // A SHAPE, not the sentence. src/auth/oauth-flow.ts states a reason that is false for anything
    // but a RangeError — it names the configured range for a port that is inside it — and that is
    // a product defect carried to its own ticket, out of scope for #74. Pinning the sentence here
    // would turn the defect into a test-enforced requirement.
    await expect(startCallbackListener(PORT, 'state', 1_000)).rejects.toThrow(
      /OAuth callback server could not start on port/,
    );
    // The product's wording is all the caller got. The refusal itself is here, with the port and
    // the call site the ticket asks for, and without this register it would have been lost.
    const raised = takeRefusals();
    expect(raised, 'the refusal was never raised at all').toHaveLength(1);
    expect(raised[0]).toContain(`Refusing to bind the fixed port ${PORT}`);
    expect(raised[0]).toMatch(/src\/auth\/oauth-flow\.ts/);
  });

  // THE REGISTER'S OWN FAILING BRANCH, which cannot be exercised from inside the suite: a case that
  // provokes it is by definition a case that fails. So the decision is a pure function and this
  // tests it directly. Its first spelling fired on any recorded refusal, which made a case that
  // correctly asserted `toThrow(/Refusing/)` go red, and made a case that merely let the refusal
  // propagate fail twice — the second time claiming something had swallowed it.
  describe('a swallowed refusal fails the case, and only a swallowed one', () => {
    // Plain consts, not split: measured against `BIND_CALL`, a const initializer is never matched
    // — the pattern needs a bind-call NAME immediately before the digits — which is why `PORT`
    // above is written plainly too.
    const PROVOKED = 18_004;
    const PROVOKED_TOO = 18_005;
    it('names the swallowed refusal when the case passed', () => {
      expect(() => createServer().listen(PROVOKED)).toThrow(/Refusing/);
      const error = swallowedRefusal(true);
      expect(error?.message).toContain('this case passed anyway (1)');
      expect(error?.message).toContain('takeRefusals()');
      expect(error?.message).toContain(`Refusing to bind the fixed port ${PROVOKED}`);
    });

    it('says nothing when the refusal became the failure', () => {
      expect(() => createServer().listen(PROVOKED_TOO)).toThrow(/Refusing/);
      expect(swallowedRefusal(false)).toBeNull();
    });

    it('says nothing when no refusal was raised at all', () => {
      expect(swallowedRefusal(true)).toBeNull();
    });
  });

  it('lets a port handed out by freePort() bind without complaint', async () => {
    const port = freePort();
    const server = await listening(createServer().listen(port, '127.0.0.1'));
    expect((server.address() as { port: number }).port).toBe(port);
  });

  // An ephemeral bind is not a fixed port: the OS picks it, so no two runs can be given the same
  // one, which is the entire failure #23 is about.
  it('lets an OS-chosen port bind', async () => {
    const server = await listening(createServer().listen(0, '127.0.0.1'));
    expect((server.address() as { port: number }).port).toBeGreaterThan(0);
  });

  // The declaration is for the case that made it, not for the worker. A permanent entry disabled
  // the refusal for that number for every case that ran afterwards in the same worker — including
  // files that never asked. These two run in order inside one file, which is what makes it
  // observable: the second one asks for the same port without declaring it.
  const SHARED_STRANGER = 18_003;
  it('lets a declared stranger bind, in the case that declared it', async () => {
    allowForeignBind(SHARED_STRANGER, 'a stranger declared by this case alone');
    const server = await listening(createServer().listen(SHARED_STRANGER, '127.0.0.1'));
    expect((server.address() as { port: number }).port).toBe(SHARED_STRANGER);
  });

  it('refuses that same port in the next case, which declared nothing', () => {
    expect(() => createServer().listen(SHARED_STRANGER)).toThrow(
      new RegExp(`Refusing to bind the fixed port ${SHARED_STRANGER}`),
    );
    claimRefusal();
  });

  // The product relies on node's own synchronous RangeError for an out-of-range port
  // (tests/auth/login-port-range.test.ts drives 70000 through the MCP boundary). A guard that
  // answered first would replace the error the user is shown.
  it('leaves an out-of-range port to node, so the RangeError still arrives', () => {
    expect(() => createServer().listen(70_000)).toThrow(RangeError);
  });


  // Scenario 3 of #74: the non-binding uses stay legal. The const above is read into a string here
  // exactly as tests/auth/token-request-timeout.test.ts reads its own, and nothing is reported,
  // because nothing binds. A guard that fired on the VALUE rather than on the bind would make that
  // file red for a port it never takes.
  it('says nothing about a port that is only put into a string', () => {
    expect(`http://localhost:${PORT}/callback`).toBe('http://localhost:18977/callback');
  });
});
