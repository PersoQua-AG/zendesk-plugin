// The runtime half of #23, pinned (#74). Its subject is the class the source scan in
// scripts/assert-no-bound-port-literals.mjs cannot see: a port that reaches listen() through a
// const, an expression or an option bag. Every case here binds through the REAL net.Server, so it
// is the shipped patch in tests/setup/no-fixed-bind-port.ts that answers, never a re-implementation
// of its rule.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { freePort } from '../auth/login-harness.js';
import { allowForeignBind, takeRefusals } from '../setup/acquired-ports.js';

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
function claimRefusals(howMany: number): void {
  expect(takeRefusals()).toHaveLength(howMany);
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
    claimRefusals(1);
  });

  // The classes the regex is documented as missing, one call each.
  //
  // MEASURED WHILE WRITING THIS, and it is the answer to #74's open question. Of the six shapes
  // here the source scan sees exactly one — the expression, which it reports by its FIRST operand,
  // so that operand is written split below the way this file's siblings are (a literal in a COMMENT
  // counts too, which is why this sentence does not spell it either). The other five it cannot see
  // at all: `18e3` does not even match its `\d[\d_]*`, the hex literal is filtered out as port 0,
  // and the option bag and the numeric string never reach the pattern. So the two instruments are
  // not redundant and the text scan stays: it refuses a bind in a file nothing executes, which this
  // one by construction cannot.
  const FIRST_OPERAND = Number(`17${'000'}`);
  it.each([
    ['an expression', () => createServer().listen(FIRST_OPERAND + 1_000)],
    ['exponent notation', () => createServer().listen(18e3)],
    ['a hex literal', () => createServer().listen(0x4650)],
    ['an option bag', () => createServer().listen({ port: 18_001 })],
    ['a numeric string', () => createServer().listen('18002')],
    // Both of these BIND 18000 — measured — while a decimal-digits test read them as a unix socket
    // path and waved them through, with the header above advertising exactly these shapes as
    // caught. node coerces the string with Number(); so does the guard now.
    ['a hex string', () => createServer().listen('0x4650')],
    ['an exponent string', () => createServer().listen('1.8e4')],
  ])('catches %s too', (_label, bind) => {
    expect(bind).toThrow(/Refusing to bind the fixed port/);
    claimRefusals(1);
  });

  // SCENARIO 1 OF #74, ON THE PATH THAT MATTERS. The product's one real bind path wraps its
  // listen() in a catch-everything and replaces whatever came out with its own wording
  // (src/auth/oauth-flow.ts), so the refusal never reaches an assertion: measured on this branch,
  // the case reported PASSED while the process exited 1 and the refusal arrived as an unhandled
  // error. src/ is out of scope for #74, so the answer is on this side — every refusal is written
  // to a register and an afterEach fails the case unless it was claimed.
  it('survives a product that catches everything around its own listen()', async () => {
    const { startCallbackListener } = await import('../../src/auth/oauth-flow.js');
    await expect(startCallbackListener(PORT, 'state', 1_000)).rejects.toThrow(
      /OAuth callback server could not start on port/,
    );
    // The product's wording is all the caller got. The refusal itself is here, with the port and
    // the call site the ticket asks for, and without this register it would have been lost.
    const [swallowed] = takeRefusals();
    expect(swallowed, 'the refusal was never raised at all').toBeDefined();
    expect(swallowed).toContain(`Refusing to bind the fixed port ${PORT}`);
    expect(swallowed).toMatch(/src\/auth\/oauth-flow\.ts/);
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
    claimRefusals(1);
  });

  // The product relies on node's own synchronous RangeError for an out-of-range port
  // (tests/auth/login-port-range.test.ts drives 70000 through the MCP boundary). A guard that
  // answered first would replace the error the user is shown.
  it('leaves an out-of-range port to node, so the RangeError still arrives', () => {
    expect(() => createServer().listen(70_000)).toThrow(RangeError);
  });

  it('lets a declared foreign bind through, which is the only way past it', async () => {
    const port = freePort() + 1;
    allowForeignBind(port, 'a stranger this case puts up on purpose');
    const server = await listening(createServer().listen(port, '127.0.0.1'));
    expect((server.address() as { port: number }).port).toBe(port);
  });

  // Scenario 3 of #74: the non-binding uses stay legal. The const above is read into a string here
  // exactly as tests/auth/token-request-timeout.test.ts reads its own, and nothing is reported,
  // because nothing binds. A guard that fired on the VALUE rather than on the bind would make that
  // file red for a port it never takes.
  it('says nothing about a port that is only put into a string', () => {
    expect(`http://localhost:${PORT}/callback`).toBe('http://localhost:18977/callback');
  });
});
