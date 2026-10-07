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
import { bindReason, endForeignBindScope, recordAcquiredPort, recordRefusal, takeRefusals } from './acquired-ports.js';

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
  if (typeof first === 'object' && first !== null && 'port' in first) {
    const port = (first as { port?: unknown }).port;
    if (typeof port !== 'string') return port;
    const coerced = Number(port);
    return Number.isNaN(coerced) ? port : coerced;
  }
  // `Number()`, not /^\d+$/: node coerces the string the same way, so `listen('0x4650')` and
  // `listen('1.8e4')` both bind 18000 — measured — and both walked past a decimal-digits test while
  // the header advertised exactly those shapes as caught. Only a NaN is a unix socket path.
  if (typeof first === 'string') {
    const coerced = Number(first);
    return Number.isNaN(coerced) ? undefined : coerced;
  }
  return first;
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
  if (isFixedBindPort(port) && bindReason(port) === undefined) {
    const message =
      `Refusing to bind the fixed port ${port} at ${callSite()}.\n` +
      'A fixed port collides with a concurrent `vitest run` (#23), whether it is written as a ' +
      'literal,\na const, 18e3 or a computed expression. Acquire one instead:\n' +
      '  const port = freePort();\n' +
      'A listener that is deliberately NOT ours — the foreign-listener cases — declares itself:\n' +
      "  allowForeignBind(port, 'why this one is a stranger');\n";
    // Written down BEFORE it is thrown, because the throw alone is not enough: the product's only
    // real bind path wraps its `listen` in a catch-everything that replaces the error with its own
    // wording (src/auth/oauth-flow.ts). The afterEach below is what makes the refusal survive that.
    recordRefusal(message);
    throw new Error(message);
  }
  const result = (realListen as (...a: unknown[]) => unknown).apply(this, args) as Server;
  // AN OS-CHOSEN PORT IS ACQUIRED, not foreign. `listen(0)` hands the number back through
  // address(), and re-binding it — which is how an EADDRINUSE is staged — is not a fixed port by
  // this guard's own definition. Recorded here so those cases stop having to declare themselves
  // as strangers, which is an escape hatch opened for a case that never needed it.
  if (!isFixedBindPort(port)) {
    this.once('listening', () => {
      const chosen = this.address();
      if (chosen !== null && typeof chosen === 'object' && typeof chosen.port === 'number') {
        recordAcquiredPort(chosen.port);
      }
    });
  }
  return result;
} as typeof realListen;

// A refusal the code under test swallowed still fails the case that produced it. Cases that
// provoke a refusal on purpose claim it with takeRefusals().
afterEach(() => {
  // A declared stranger is declared for the case that declared it, and not for every case that
  // runs after it in the same worker.
  endForeignBindScope();
  const swallowed = takeRefusals();
  if (swallowed.length > 0) {
    throw new Error(
      `A bind-time port refusal was raised and did not reach this assertion (${swallowed.length}).\n` +
        'Something between the bind and the test swallowed it — the product wraps its listen() in a\n' +
        'catch-all, so the refusal below arrived under a different wording or not at all.\n\n' +
        swallowed.join('\n'),
    );
  }
});
