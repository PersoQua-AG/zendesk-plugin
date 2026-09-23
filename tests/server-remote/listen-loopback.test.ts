import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { listenLoopback } from './harness.js';
import { settlesWithin } from '../auth/login-harness.js';

// #13, second site of the same class: a port reservation that is not exclusive.
//
// callback.test.ts, rate-limit.test.ts, isolation.test.ts and remote-init.test.ts each bound their
// server with a bare listen(0) — the wildcard — and then dialled 127.0.0.1. A wildcard bind does not
// reserve the loopback address on every platform (measured on macOS/node v22: address() is "::", and
// a second process binds 127.0.0.1 on that same port without EADDRINUSE), so the client can reach a
// stranger. Symptom on record: `FAIL tests/server-remote/callback.test.ts > rejects an unknown state`.
//
// Repetition cannot show this is gone either, so what is asserted here is the property: the address
// the test server binds is the address its client dials, it is held from bind to close, and a second
// bind on it is refused. Plus the one thing that keeps the lesson from being lost a second time —
// that no suite in this directory puts a server on a port any other way.

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
});

function track<T extends Server>(server: T): T {
  servers.push(server);
  return server;
}

function bindLoopback(port: number): Promise<Server> {
  const server = track(createServer());
  return new Promise((bound, failed) => {
    server.on('error', failed);
    server.listen(port, '127.0.0.1', () => bound(server));
  });
}

describe('the port a remote test server is put on', () => {
  it('is the address its client dials, and is held against a second bind', async () => {
    const { server, port, base } = await listenLoopback(
      track(createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ours'))),
    );
    servers.push(server);

    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    expect(await (await fetch(`${base}/`)).text()).toBe('ours');
    // The reservation, stated: while this suite holds the port, nothing else on this machine can
    // take the address the client resolves. The pre-fix wildcard bind gives no such answer.
    await expect(bindLoopback(port)).rejects.toThrow(/EADDRINUSE/);
  });

  it('is refused when the bind ignored the host — the pre-fix shape, named at the bind', async () => {
    // A server that drops the host argument is exactly what the bare wildcard bind was. listenLoopback must
    // not hand such a server on as if its port were reserved.
    const wildcard = track(createServer());
    const droppingHost = { listen: (p: number, _host: string) => wildcard.listen(p) };

    await expect(listenLoopback(droppingHost)).rejects.toThrow(/not 127\.0\.0\.1/);
    // And the refused server is not left listening: the caller never got a handle to close.
    expect(wildcard.listening).toBe(false);
  });

  // A bind that fails must REJECT, not hang. A pending promise here looks exactly like a slow test
  // until the suite timeout, and the whole file it sits in stops reporting anything useful — the
  // liveness class #9 was about. settlesWithin states it as liveness rather than as a slow assert.
  it('settles when the bind fails, instead of hanging on a promise nobody resolves', async () => {
    const taken = track(createServer());
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    const occupied = (taken.address() as AddressInfo).port;
    // An app whose listen ignores the port it is given and walks into an EADDRINUSE.
    const refusing = { listen: (_p: number, host: string) => track(createServer()).listen(occupied, host) };

    await expect(settlesWithin('listenLoopback on a refused bind', listenLoopback(refusing), 1_500)).rejects.toThrow(
      /EADDRINUSE/,
    );
  });

  // The lesson lived in a comment inside harness.ts and four suites never read it. A comment cannot
  // fail; this can. Matches an ephemeral bind that does NOT name the loopback address — `.listen(0)`,
  // `.listen( 0 )`, `.listen(0, cb)` and `.listen(0, '0.0.0.0')` alike — across both test trees,
  // because the class is not confined to one directory.
  const WILDCARD_BIND = /\.listen\(\s*0\s*(?!,\s*'127\.0\.0\.1')/;

  // harness.ts owns the correct bind; this file demonstrates the wrong one on purpose; and
  // oauth-flow.bind-liveness.test.ts binds the wildcard DELIBERATELY — it needs the collision with
  // the production listener's own wildcard bind, and a loopback host would make it prove nothing.
  const EXEMPT = new Set(['harness.ts', 'listen-loopback.test.ts', 'oauth-flow.bind-liveness.test.ts']);

  it('is acquired without a wildcard bind by every suite in tests/', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const trees = [here, join(here, '..', 'auth')];
    const offenders = trees.flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith('.ts') && !EXEMPT.has(name))
        .filter((name) => WILDCARD_BIND.test(readFileSync(join(dir, name), 'utf8')))
        .map((name) => join(dir, name)),
    );
    expect(offenders).toEqual([]);
  });
});
