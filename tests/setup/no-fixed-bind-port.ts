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

// A bag whose handle or fd decides the bind, so whatever `port` it also carries is not the port.
// Distinct from `undefined`, which means "no port was named at all" — the two used to be one value
// and that is what registered a handle's FIXED port as if the OS had chosen it.
const HANDLE = Symbol('bound by handle or fd');

// listen(port), listen(port, host), listen({ port }), listen('8976'), listen(path), listen(handle).
// A non-numeric string is a unix socket path, not a port.
function portOf(args: unknown[]): unknown {
  const first = args[0];
  // `handle` and `fd` WIN over a port in the same bag, because node binds the handle and ignores
  // options.port — reading the port there falsely refused `listen({ handle, port: 18996 })`.
  //
  // A VALUE CHECK, NOT `in`. `'handle' in bag` is true of `{ handle: undefined, port: 18931 }`,
  // which is an ordinary optional-handle shape and which node binds on 18931: measured, it BOUND
  // 18931 with the guard silent. node's own test is `options.fd >= 0` / `options.handle` being
  // truthy, and so is this.
  const bag = typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : null;
  if (bag && (bag.handle != null || bag.fd != null)) return HANDLE;
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
    // Written down AND emitted before it is thrown, because the throw alone can be eaten: see the
    // refusal log in ./acquired-ports.ts for the three measured shapes of enforcement that failed
    // correct tests, and for why a log is the right size of answer.
    recordRefusal(message);
    throw new Error(message);
  }
  const result = (realListen as (...a: unknown[]) => unknown).apply(this, args) as Server;
  // AN OS-CHOSEN PORT IS ACQUIRED, not foreign. `listen(0)` hands the number back through
  // address(), and re-binding it — which is how an EADDRINUSE is staged — is not a fixed port by
  // this guard's own definition. Recorded here so those cases stop having to declare themselves as
  // strangers, which is an escape hatch opened for a case that never qualified.
  //
  // THE CONDITION IS "THE CALLER ASKED FOR AN EPHEMERAL PORT", and it is read off the ARGUMENTS
  // rather than off `portOf` returning nothing. Those are not the same question, and conflating
  // them was a hole: `portOf` answers `undefined` for a handle or fd bag too, so a handle ALREADY
  // BOUND to a fixed port had that port registered permanently — measured, a bag reusing the handle
  // of a server that held a declared stranger made that number declared, and a later bare bind of it
  // then succeeded, undeclared and unrefused. Exactly the mis-registration this comment used to claim
  // it had avoided.
  //
  // Asking for an ephemeral port means: no arguments at all, a callback first, or a port of 0.
  // A handle or an fd is NOT asking — the handle decides, and the guard records nothing.
  //
  // The entry is permanent, unlike a declared stranger: a server bound once in a beforeAll is
  // re-bound by the cases, so a per-case scope would refuse it. What keeps that safe is that an
  // ephemeral range cannot excuse a PORT_BAND literal — measured on darwin, 49152-65535 against a
  // band of 20000-29999, and on Linux the default is 32768-60999. Both are sysctl-tunable, so this
  // is a property of the machines this suite runs on and not a law.
  const wantsEphemeral = args.length === 0 || typeof args[0] === 'function' || port === 0;
  if (wantsEphemeral) {
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
