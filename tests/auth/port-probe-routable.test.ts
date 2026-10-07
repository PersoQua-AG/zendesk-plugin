// #106 finding 2: freePort() handed out a band port a stranger held on a ROUTABLE address of this
// host, because all three of portHeldOn's addresses stayed bindable beside it under macOS's
// SO_REUSEADDR. The symptom was one test file away — tests/auth/oauth-flow.dual-bind.test.ts:79
// asserts that a non-loopback address of this host refuses the callback connection and read
// 'connected' instead, in 1 of 3 full runs. The reasoning is in login-harness.ts above
// routableAddresses(); this is the case that holds it.
import { describe, it, expect, afterEach } from 'vitest';
import { once } from 'node:events';
import { createServer, type Server } from 'node:net';
import { networkInterfaces } from 'node:os';
import { freePort, portHeldOn } from './login-harness.js';

// THE GUARD MAY NOT BE DERIVED FROM THE SUBJECT, and briefly it was. Reusing the harness's
// `routableAddresses()` here looked like the right de-duplication and made the whole file report
// GREEN when that function was ablated to `[]` — it skipped itself. Measured:
//   ABLATION A: routableAddresses() -> []   ->   Tests  1 skipped (1)
// So the address comes from an independent walk. It is deliberately NOT shared with the harness:
// a control whose precondition is computed by the code under test controls nothing.
//
// Non-internal IPv4 specifically: it is the family the measurement was taken on and the one
// dual-bind.test.ts asks about (firstNonLoopbackIPv4), and excluding internal keeps a loopback
// alias such as 127.0.0.2 from being tested under the name "a routable address". A machine with
// none is SKIPPED by name rather than passed silently.
function routableIPv4(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((i) => i !== undefined && !i.internal && i.family === 'IPv4')?.address;
}

describe('portHeldOn() and a stranger on a routable address', () => {
  const opened: Server[] = [];
  afterEach(async () => {
    for (const s of opened.splice(0)) {
      s.close();
      await once(s, 'close');
    }
  });

  it.skipIf(routableIPv4() === undefined)('does not call that port free', async () => {
    const host = routableIPv4()!;
    const port = freePort();
    const stranger = createServer();
    stranger.listen(port, host);
    await once(stranger, 'listening');
    opened.push(stranger);
    // Which address is NAMED differs by platform and is not the property: on macOS the wildcard
    // probe binds beside the stranger and only the specific address refuses, on Linux the wildcard
    // refuses first. What must never happen is the empty string, which means FREE.
    expect(portHeldOn(port), `a stranger is listening on ${host}:${port}`).not.toBe('');

    // AND IT HAS TO CONTROL ON LINUX, which the line above does not. There `0.0.0.0` refuses for
    // ANY IPv4 holder (login-harness.ts's measured matrix), so that assertion stays green with
    // routableAddresses() ablated — green on the one platform CI runs. Naming a strict set with no
    // wildcard in it leaves the discovered addresses as the only thing that can answer, on both
    // platforms: `127.0.0.1` binds beside a routable holder everywhere.
    expect(
      portHeldOn(port, ['127.0.0.1']),
      `only the discovered addresses can see a stranger on ${host}:${port} from a loopback probe`,
    ).toBe(host);
  });
});
