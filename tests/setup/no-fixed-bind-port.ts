// Global bind-time port guard (vitest setupFiles), the runtime half of #23.
//
// WHY THIS EXISTS NEXT TO A TEXT SCAN. scripts/assert-no-bound-port-literals.mjs reads source and
// matches a regex, so it sees only a decimal literal written at the call site. Every class it
// misses — a const, a variable, 18e3, 0x4650, a computed port, an option bag, a bind under a call
// name outside its list — arrives here as a NUMBER at the moment the socket is bound, which is the
// only place the two spellings stop being different. The living template of that class is
// tests/plugin/bind-time-port-guard.test.ts:18 + :41 — a const that reaches listen() and is refused
// here, while check:ports stays green over the same tree: unseen by the scan, not absent.
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
const bagOf = (first: unknown): Record<string, unknown> | null =>
  typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : null;

// NODE'S OWN TEST, not an approximation of it, and shared by the two questions that need it so they
// cannot drift apart. `'handle' in bag` is true of `{ handle: undefined, port: 18931 }`, an ordinary
// optional-handle shape that node binds on 18931 — measured, it BOUND 18931 with the guard silent.
// `!= null` then admitted `fd: -1`, the canonical absent-fd sentinel, as well as `handle: 0`,
// `handle: false` and `fd: NaN`: measured, four more fixed ports bound with the guard silent, the
// same class one value over. node asks `options.fd >= 0` and whether `options.handle` is truthy.
const handleDecides = (bag: Record<string, unknown>): boolean =>
  (typeof bag.fd === 'number' && bag.fd >= 0) || Boolean(bag.handle);

// "The caller asked for the OS to choose", read off the ARGUMENTS rather than off `portOf`, which
// answers `undefined` both for "no port named" and for "a handle decides" and so cannot tell them
// apart. Conflating those two registered a handle's FIXED port as if the OS had chosen it, and the
// positional arms were each missing at some point — `listen(cb)`, then `listen(undefined, cb)` —
// with the OS-chosen port going unrecorded so a later legitimate re-bind of it was refused. Both
// are pinned by cases that go red when their arm is removed.
//
// NO BAG-LEVEL NULLISH ARM, and that is measured rather than assumed. A review round reported
// `{ port: undefined }` and `{ port: null }` as unrecorded, from a harness that called this patch
// directly. Through node they never arrive that way: instrumenting the patched `listen` shows node
// normalising `{ port: undefined, host }` to `{ port: 0, host }` BEFORE the prototype is reached,
// so `Number(bag.port) === 0` already answers them. An arm for it was written, could not be made
// red by any ablation, and was removed as the dead code it is.
function asksForEphemeral(args: unknown[]): boolean {
  if (args.length === 0) return true;
  const first = args[0];
  if (first === undefined || first === null || typeof first === 'function') return true;
  const bag = bagOf(first);
  if (bag === null) return Number(first) === 0;
  // A handle is not asking — it decides, and then there is nothing of the OS's to record.
  if (handleDecides(bag)) return false;
  return Number(bag.port) === 0;
}

function portOf(args: unknown[]): unknown {
  const first = args[0];
  // `handle` and `fd` WIN over a port in the same bag, because node binds the handle and ignores
  // options.port — reading the port there falsely refused `listen({ handle, port: 18996 })`.
  //
  // Returning `undefined` rather than a distinct sentinel is enough: nothing downstream asks
  // whether `portOf` answered nothing. `asksForEphemeral` reads the ARGUMENTS, which is what closed
  // the mis-registration a sentinel was briefly added for as well.
  const bag = bagOf(first);
  if (bag !== null && handleDecides(bag)) return undefined;
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
  // Asking for an ephemeral port is decided by `asksForEphemeral`, above, which is where the shapes
  // and their measurements live. A handle or an fd is NOT asking, so nothing is recorded for it.
  //
  // The entry is permanent, unlike a declared stranger: a server bound once in a beforeAll is
  // re-bound by the cases, so a per-case scope would refuse it. What keeps that safe is that an
  // ephemeral range cannot excuse a PORT_BAND literal — measured on darwin, 49152-65535 against a
  // band of 20000-29999, and on Linux the default is 32768-60999. Both are sysctl-tunable, so this
  // is a property of the machines this suite runs on and not a law.
  if (asksForEphemeral(args)) {
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
