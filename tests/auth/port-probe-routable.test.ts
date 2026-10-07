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

// The stranger is put on IPv4 specifically: it is the family the measurement was taken on and the
// one dual-bind.test.ts asks about (firstNonLoopbackIPv4). A machine with none is SKIPPED by name
// rather than passed silently — a green assertion nobody could have made is the shape this whole
// ticket is about.
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
  });
});
