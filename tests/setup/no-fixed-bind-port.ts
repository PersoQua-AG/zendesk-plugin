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
import { bindReason } from './acquired-ports.js';

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
    return typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : port;
  }
  if (typeof first === 'string') return /^\d+$/.test(first) ? Number(first) : undefined;
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
    throw new Error(
      `Refusing to bind the fixed port ${port} at ${callSite()}.\n` +
        'A fixed port collides with a concurrent `vitest run` (#23), whether it is written as a ' +
        'literal,\na const, 18e3 or a computed expression. Acquire one instead:\n' +
        '  const port = freePort();\n' +
        'A listener that is deliberately NOT ours — the foreign-listener cases — declares itself:\n' +
        "  allowForeignBind(port, 'why this one is a stranger');\n",
    );
  }
  return (realListen as (...a: unknown[]) => unknown).apply(this, args) as Server;
} as typeof realListen;
