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
export function allowForeignBind(port: number, why: string): number {
  reasons.set(port, why);
  return port;
}

export function bindReason(port: number): string | undefined {
  return reasons.get(port);
}
