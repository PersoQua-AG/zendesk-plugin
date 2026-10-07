// The register behind the bind-time refusal (#74). Separate from the setup file that enforces it so
// that login-harness.ts can record an acquisition without importing the patch, and separate from
// login-harness.ts so that a suite which never touches the login fixture still gets the refusal.
//
// WHY A REGISTER AND NOT A RANGE CHECK. "Is this port inside PORT_BAND?" would pass any literal
// somebody writes inside the band, which is the mistake one layer up. What is in here is a port
// this process did not WRITE DOWN: one freePort() handed over, and one the OS chose for a
// `listen(0)` and handed back through address(). Neither can be the same number in two concurrent
// runs, which is the whole of #23.
// A SET, not a map of reasons. The `why` strings went in and were never read back: `isDeclaredPort`
// is the only consumer and it asks one question. The `why` parameter stays, because it is the
// call-site documentation the refusal message advertises — it just is not stored.
const acquired = new Set<number>();

// Called by freePort() at the moment it hands a port over, so the register can never be ahead of
// what was really acquired.
export function recordAcquiredPort(port: number): number {
  acquired.add(port);
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
// setup file clears this set in an afterEach, which is the size every call site actually needs:
// each one stands immediately above the bind it is excusing.
//
// NOT one shot. Measured: src/tools/diagnostics.ts binds its probe port more than once per call,
// so consuming the entry at the first bind turned a declared stranger back into a refusal halfway
// through the product's own retry.
const foreign = new Set<number>();

export function allowForeignBind(port: number, _why: string): void {
  foreign.add(port);
}

export function isDeclaredPort(port: number): boolean {
  return acquired.has(port) || foreign.has(port);
}

export function endForeignBindScope(): void {
  foreign.clear();
}

// THE REFUSAL LOG IS A DIAGNOSTIC, NOT AN ENFORCEMENT. It exists so a test can READ a refusal that
// the code under test swallowed: the product's one real bind path wraps its `listen` in a
// catch-everything and replaces the error with its own wording (src/auth/oauth-flow.ts:331-340),
// so without this the port and the call site #74 asks for are simply gone by the time the test
// looks. tests/plugin/bind-time-port-guard.test.ts reads them out of here.
//
// AN EARLIER VERSION ENFORCED IT IN HOOKS, and that was wrong three times over — each shape
// measured by `qa-engineer`, each one a CORRECT test turned red with a false explanation: a plain
// accidental bind failed twice, the second time claiming something had swallowed a refusal that
// had already failed the case; a refusal thrown from a suite-level `afterEach` aborted the hook
// chain before the setup's own ran, so it leaked and failed the NEXT case, which had bound
// nothing; and an `afterAll` bind produced both the refusal naming its file:line and a second
// error insisting nothing could attribute it to a case.
//
// The enforcement was also buying very little. The guard is protective AT THE BIND: the fixed port
// is never bound, so the #23 collision it exists to prevent cannot happen whether or not anything
// later reads the log. What a swallowed refusal costs is the DIAGNOSTIC — the author sees the
// product's wording instead of the guard's — and a diagnostic is worth a log, not a hook that
// fails cases which are right.
const refusals: string[] = [];

export function recordRefusal(message: string): void {
  refusals.push(message);
}

/** Drains the log. The guard's own test reads it; nothing else has to. */
export function takeRefusals(): string[] {
  return refusals.splice(0);
}
