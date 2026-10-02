import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { startCallbackListener } from '../../src/auth/oauth-flow.js';
import { freePort, occupyPort, setupLoginHarness } from './login-harness.js';

setupLoginHarness('oauth-dual-bind-');

// `localhost` is not one address. On macOS it resolves to ::1 BEFORE 127.0.0.1, and the redirect_uri
// registered with Zendesk says `localhost` — so the listener has to answer on both families. The
// wildcard bind this replaced answered on both and on every routable interface of the machine too,
// which is what the last case here is about.

// Whether this machine has an IPv6 loopback at all. A container can be built without one, and then
// `localhost` resolves to 127.0.0.1 and the ::1 half of the bind legitimately fails — the listener
// still comes up, which is the whole point of continuing on one family.
async function ipv6LoopbackAvailable(): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.on('error', () => done(false));
    probe.listen(freePort(), '::1', () => probe.close(() => done(true)));
  });
}

function firstNonLoopbackIPv4(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return undefined;
}

// A raw TCP connect, not fetch(): the suite's network guard (tests/setup/no-network.ts) rejects a
// non-loopback fetch itself, which would prove nothing about the bind.
function tcpOutcome(host: string, port: number): Promise<string> {
  return new Promise((done) => {
    const socket = connect({ host, port, timeout: 2_000 });
    socket.on('connect', () => {
      socket.destroy();
      done('connected');
    });
    socket.on('timeout', () => {
      socket.destroy();
      done('timeout');
    });
    socket.on('error', (err) => done((err as NodeJS.ErrnoException).code ?? err.message));
  });
}

describe('the callback listener', () => {
  it('answers on 127.0.0.1, on [::1] and on localhost — the three spellings of the redirect', async () => {
    const port = freePort();
    const hasIPv6 = await ipv6LoopbackAvailable();
    const listener = await startCallbackListener(port, 'state', 5_000);
    try {
      const hosts = hasIPv6 ? ['127.0.0.1', '[::1]', 'localhost'] : ['127.0.0.1', 'localhost'];
      for (const host of hosts) {
        // A path that is not /callback: 404 and the pending authorization survives, so one listener
        // answers all three without the flow ending on the first.
        const response = await fetch(`http://${host}:${port}/not-the-callback`);
        expect(response.status, host).toBe(404);
      }
    } finally {
      listener.close();
      await expect(listener.promise).rejects.toThrow(/closed/);
    }
  });

  it('is not reachable on a non-loopback address of this host', async () => {
    const host = firstNonLoopbackIPv4();
    // A machine with no routable interface cannot be asked the question; nothing to assert, and
    // nothing to pass silently either — the loopback cases above still ran.
    if (!host) return;
    const port = freePort();
    const listener = await startCallbackListener(port, 'state', 5_000);
    try {
      expect(await tcpOutcome(host, port)).toBe('ECONNREFUSED');
    } finally {
      listener.close();
      await expect(listener.promise).rejects.toThrow(/closed/);
    }
  });

  it('comes up on the family that bound when the other one cannot, and warns with its code', async () => {
    if (!(await ipv6LoopbackAvailable())) return;
    const port = freePort();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Only 127.0.0.1 is taken. A listener that gave up here would be a login nobody can complete, and
    // one that said nothing would hide a half-reachable callback.
    //
    // What this case does NOT ask is whether the URL the user is handed is reachable in this state —
    // that is the other half of #68 B2, and it is pinned in tests/auth/setup-flow.test.ts ("names a
    // family it actually bound, not one a stranger holds"): it fetches the URL out of the tool's own
    // answer and asserts the page that comes back is ours.
    const blocker = createServer(() => {});
    await new Promise<void>((bound) => blocker.listen(port, '127.0.0.1', () => bound()));
    try {
      const listener = await startCallbackListener(port, 'state', 5_000);
      expect(warn.mock.calls.flat().join(' ')).toMatch(/could not bind 127\.0\.0\.1:\d+ \(EADDRINUSE\)/);
      // And the callback still lands, over the family that did bind.
      await fetch(`http://[::1]:${port}/callback?state=state&code=over-ipv6`);
      await expect(listener.promise).resolves.toMatchObject({ code: 'over-ipv6' });
    } finally {
      warn.mockRestore();
      await new Promise<void>((closed) => blocker.close(() => closed()));
    }
  });

  it('fails only when neither family binds', async () => {
    const port = freePort();
    const release = await occupyPort(port);
    try {
      await expect(startCallbackListener(port, 'state', 5_000)).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await release();
    }
  });
});
