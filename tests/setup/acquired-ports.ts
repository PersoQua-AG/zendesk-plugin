// The register behind the bind-time refusal (#74). Separate from the setup file that enforces it so
// that login-harness.ts can record an acquisition without importing the patch, and separate from
// login-harness.ts so that a suite which never touches the login fixture still gets the refusal.
//
// WHY A REGISTER AND NOT A RANGE CHECK. "Is this port inside PORT_BAND?" would pass any literal
// somebody writes inside the band, which is the mistake one layer up. Only a port this process
// actually took out of freePort() is in here.
const reasons = new Map<number, string>();

// Called by freePort() at the moment it hands a port over, so the register can never be ahead of
// what was really acquired.
export function recordAcquiredPort(port: number): number {
  reasons.set(port, 'freePort()');
  return port;
}

// THE ONE ESCAPE HATCH, AND IT HAS TO SAY WHY. A handful of cases bind a port deliberately NOT
// taken from the allocator: they are simulating the foreign listener that #48 was about, and
// `freePort() + 1` is the whole point of them. Those are legitimate and few, so they are named here
// rather than exempted by a pattern — a pattern would quietly re-admit the class this guard exists
// to refuse.
// SCOPED TO THE CASE THAT ASKED FOR IT, not to the worker. A permanent entry disabled the refusal
// for that number for the rest of the worker's life, so a later accidental fixed bind of the same
// port — in this file or in any file that ran after it in the same worker — passed unseen. The
// setup file clears this map in an afterEach, which is the size every call site actually needs:
// each one stands immediately above the bind it is excusing.
//
// NOT one shot. Measured: src/tools/diagnostics.ts binds its probe port more than once per call,
// so consuming the entry at the first bind turned a declared stranger back into a refusal halfway
// through the product's own retry.
const foreign = new Map<number, string>();

export function allowForeignBind(port: number, why: string): number {
  foreign.set(port, why);
  return port;
}

export function endForeignBindScope(): void {
  foreign.clear();
}

export function bindReason(port: number): string | undefined {
  return reasons.get(port) ?? foreign.get(port);
}

// A REFUSAL THAT WAS SWALLOWED MUST STILL FAIL THE RUN. The guard throws at the bind, and the one
// real bind path in the product catches everything around its `listen` and replaces the error with
// its own wording (src/auth/oauth-flow.ts). Measured on this branch before this register existed:
// the case reported PASSED while the process exited 1 and the refusal arrived as an unhandled
// error — #74 scenario 1 unmet on the only path where it matters. So every refusal is written down
// here as well, and an afterEach in the setup file fails the case unless somebody has claimed it.
const refusals: string[] = [];

export function recordRefusal(message: string): void {
  refusals.push(message);
}

/** Drains the refusals, for the cases that provoke one on purpose. */
export function takeRefusals(): string[] {
  return refusals.splice(0);
}
