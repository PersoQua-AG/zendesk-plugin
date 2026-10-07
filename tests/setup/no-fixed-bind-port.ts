// Global bind-time port guard (vitest setupFiles), the runtime half of #23.
//
// WHY THIS EXISTS NEXT TO A TEXT SCAN. scripts/assert-no-bound-port-literals.mjs reads source and
// matches a regex, so it sees only a decimal literal written at the call site. Every class it
// misses — a const, a variable, 18e3, 0x4650, a computed port, an option bag, a bind under a call
// name outside its list — arrives here as a NUMBER at the moment the socket is bound, which is the
// only place the two spellings stop being different. `const PORT = 18977` used to be the living
// template of that class (tests/auth/token-request-timeout.test.ts); a reader could not tell from
// the green scan that it was unseen rather than absent.
//
// The scan is not redundant and is kept: it refuses a literal in a file no test ever executes, and
// it names file and line at review time rather than at bind time. This one refuses the number
// however it was written, but only along a path a test actually runs. Neither subsumes the other.
import { Server } from 'node:net';
import { afterEach } from 'vitest';
import { endForeignBindScope, isDeclaredPort, recordAcquiredPort, recordRefusal } from './acquired-ports.js';

// 0 is chosen by the OS and anything outside 1-65535 is refused by listen() itself — neither is a
// fixed port, and the out-of-range case must keep reaching node so that the RangeError the product
// relies on still arrives (tests/auth/login-port-range.test.ts drives exactly that with 70000).
function isFixedBindPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535;
}

// listen(port), listen(port, host), listen({ port }), listen('8976'), listen(path), listen(handle).
// A non-numeric string is a unix socket path, not a port.
function portOf(args: unknown[]): unknown {
  const first = args[0];
  // `handle` and `fd` WIN over a port in the same bag: node binds the handle and ignores
  // options.port, so reading the port there falsely refused `listen({ handle, port: 18996 })`.
  const bag = typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : null;
  if (bag && ('handle' in bag || 'fd' in bag)) return undefined;
  const raw = bag && 'port' in bag ? bag.port : first;
  if (typeof raw !== 'string') return raw;
  // `Number()`, not /^\d+$/: node coerces the string the same way, so `listen('0x4650')` and
  // `listen('1.8e4')` both bind 18000 — measured — and both walked past a decimal-digits test while
  // the header advertised exactly those shapes as caught.
  //
  // A unix socket path becomes NaN and needs no special case: `isFixedBindPort` asks
  // `Number.isInteger`, which NaN fails. Measured — mapping NaN to `undefined` here changed no
  // verdict, so the line is gone and the socket-path case in the guard's test pins the behaviour
  // rather than this mapping.
  return Number(raw);
}

// The frame that asked for the bind, not the frames of this file or of node's own internals — a
// refusal that names only `listen` costs the reader the search this guard exists to spare them.
function callSite(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  const mine = frames.find(
    (f) => /\/tests\/|\/src\//.test(f) && !f.includes('/tests/setup/no-fixed-bind-port'),
  );
  // Without the leading `at ` the frame already carries: the sentence below supplies that word.
  return mine?.trim().replace(/^at /, '') ?? 'an unknown call site';
}

const realListen = Server.prototype.listen;

// eslint-disable-next-line func-names
Server.prototype.listen = function (this: Server, ...args: unknown[]) {
  const port = portOf(args);
  if (isFixedBindPort(port) && !isDeclaredPort(port)) {
    const message =
      `Refusing to bind the fixed port ${port} at ${callSite()}.\n` +
      'A fixed port collides with a concurrent `vitest run` (#23), whether it is written as a ' +
      'literal,\na const, 18e3 or a computed expression. Acquire one instead:\n' +
      '  const port = freePort();\n' +
      'A listener that is deliberately NOT ours — the foreign-listener cases — declares itself:\n' +
      "  allowForeignBind(port, 'why this one is a stranger');\n";
    // Written down BEFORE it is thrown: the throw alone is not enough. Why, and what was measured,
    // is on swallowedRefusal() in ./acquired-ports.ts.
    recordRefusal(message);
    throw new Error(message);
  }
  const result = (realListen as (...a: unknown[]) => unknown).apply(this, args) as Server;
  // AN OS-CHOSEN PORT IS ACQUIRED, not foreign. `listen(0)` hands the number back through
  // address(), and re-binding it — which is how an EADDRINUSE is staged — is not a fixed port by
  // this guard's own definition. Recorded here so those cases stop having to declare themselves as
  // strangers, which is an escape hatch opened for a case that never qualified.
  //
  // THE CONDITION IS "THE CALLER ASKED FOR AN EPHEMERAL PORT", not "the first argument was not a
  // fixed number". Those differ: `listen({ fd })` and a pre-bound handle name no port at all, and
  // under the looser test their fixed port was recorded as acquired for the rest of the worker's
  // life — a mis-registration that re-admits the class this guard refuses. `listen(cb)` DOES ask
  // for one and was missed by the first spelling of this: measured, the OS-chosen port went
  // unrecorded and a later legitimate re-bind of it was refused.
  //
  // The entry is permanent, unlike a declared stranger. An ephemeral range (49152-65535 on macOS,
  // 32768-60999 on Linux) does not meet PORT_BAND, so a recorded OS port cannot excuse a band
  // literal; and a server bound once in a beforeAll is re-bound by the cases, so a per-case scope
  // would refuse it.
  if (port === undefined || port === 0 || typeof args[0] === 'function') {
    this.once('listening', () => {
      const chosen = this.address();
      if (chosen !== null && typeof chosen === 'object' && typeof chosen.port === 'number') {
        recordAcquiredPort(chosen.port);
      }
    });
  }
  return result;
} as typeof realListen;

// A declared stranger is declared for the case that declared it, and not for every case that runs
// after it in the same worker.
//
// THE HOOK ORDER MATTERS AND IS NOT DECLARED ANYWHERE ELSE: vitest's `sequence.hooks` default is
// "stack", so a setup file's afterEach runs AFTER the test file's own — which is what lets a bind
// in a file's cleanup hook still be refused against a stranger that file declared. Setting
// `sequence.hooks` to "list" or "parallel" in vitest.config.ts would reverse that; this comment is
// the only thing saying so.
afterEach(endForeignBindScope);
