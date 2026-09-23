import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type RequestListener, type Server } from 'node:http';
import {
  PORT_BAND_FIRST,
  PORT_BAND_LAST,
  answerFromOurListener,
  closeRawSockets,
  freePort,
  portClaimPath,
} from './login-harness.js';

// #13, structurally. The defect was a TOCTOU window: freePort() bound port 0, read the number,
// CLOSED the listener and returned it, and the caller bound it afterwards. Between those two
// moments any listen(0) on the machine could be handed the same number — measured as a raw request
// answered by a listener that was not ours.
//
// "The suite was green N times" cannot show that such a window is gone; a race that fires in one
// run of four survives ten green runs easily. So each case below states a property of the
// acquisition itself, and each one is RED against the pre-fix shape:
//
//   band       — a closed listen(0) port is an EPHEMERAL port, which is exactly the pool every
//                other listen(0) draws from. The new shape draws from a band that pool excludes.
//   claim      — the pre-fix shape held nothing after it returned. The new one holds a claim from
//                before the number is known to the caller until the process exits.
//   distinct   — two acquisitions never coincide.
//   foreign    — and when a port IS taken by something else, the failure says so.

const listeners: Server[] = [];

afterEach(() => {
  for (const server of listeners.splice(0)) server.close();
  closeRawSockets();
});

function serve(port: number, handler?: RequestListener): Promise<void> {
  const server = createServer(handler);
  listeners.push(server);
  return new Promise((listening, failed) => {
    server.on('error', failed);
    server.listen(port, '127.0.0.1', listening);
  });
}

// The kernel's ephemeral range, or null when this platform does not publish one where we look. Null
// is a real outcome, not a failure: the case below still asserts the band against the LOWEST range
// any platform we run on uses, and only tightens that to the measured range when there is one.
function ephemeralRangeFirst(): number | null {
  try {
    if (process.platform === 'linux') {
      return Number.parseInt(readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').split(/\s+/)[0], 10);
    }
    if (process.platform === 'darwin') {
      return Number.parseInt(execFileSync('sysctl', ['-n', 'net.inet.ip.portrange.first'], { encoding: 'utf8' }), 10);
    }
    return null;
  } catch {
    return null;
  }
}

describe('the port a test is given', () => {
  // Linux starts its ephemeral range at 32768, macOS and Windows at 49152. A band below all three
  // cannot be handed to a listen(0) anywhere on this machine — which is the whole of the fix: there
  // is no window because there is no shared pool to race over.
  const LOWEST_EPHEMERAL_FIRST = 32_768;

  it('is drawn from a band no listen(0) can be given', () => {
    const port = freePort();
    expect(port).toBeGreaterThanOrEqual(PORT_BAND_FIRST);
    expect(port).toBeLessThanOrEqual(PORT_BAND_LAST);
    // Above the privileged range too, which src/auth/config.ts CALLBACK_PORT_RULE requires.
    expect(PORT_BAND_FIRST).toBeGreaterThan(1023);
    expect(PORT_BAND_LAST).toBeLessThan(LOWEST_EPHEMERAL_FIRST);

    const measured = ephemeralRangeFirst();
    if (measured === null) return;
    expect(Number.isFinite(measured)).toBe(true);
    expect(PORT_BAND_LAST).toBeLessThan(measured);
  });

  it('is already claimed when the caller receives it, and the claim names its owner', () => {
    const port = freePort();
    const claim = portClaimPath(port);
    // The claim is never observable without its owner — it is published by link(), not created and
    // then filled in. A claim that could be read empty is one a concurrent sweep calls ownerless and
    // removes, and then the port goes out twice.
    expect(readFileSync(claim, 'utf8')).toBe(String(process.pid));
    // A second acquirer — another vitest worker, another `vitest run`, this line — is refused, and
    // atomically: there is no moment between the check and the claim in which both could succeed.
    expect(() => writeFileSync(claim, 'someone else', { flag: 'wx' })).toThrow(/EEXIST/);
  });

  // The concurrency scenario of #13, and the one case that needs a real bind: that nobody else holds
  // the number is what a bind proves and an assertion about the number cannot. No request is sent
  // over these sockets — that would test the OS, not the acquisition.
  // Within one process. Across processes — the case #13 actually failed on, another vitest worker —
  // no in-process test can state it; that one is measured in the PR's control run, where the pre-fix
  // shape hands the same number to two processes and this one does not.
  it('is never the port another acquisition is given, and is free when the caller binds', async () => {
    const ports = Array.from({ length: 32 }, () => freePort());
    expect(new Set(ports).size).toBe(ports.length);
    await Promise.all(ports.map((port) => serve(port)));
  });
});

describe('a listener on our port that is not ours', () => {
  it('is reported as a foreign listener, not as a wrong status from our own code', async () => {
    const port = freePort();
    // What #13 actually met: an answer our callback listener cannot produce on /callback.
    await serve(port, (_req, res) => res.writeHead(404).end());

    const failure = await answerFromOurListener(port, '/callback?state=wrong').then(
      (answer) => new Error(`expected a failure, got ${JSON.stringify(answer)}`),
      (err: Error) => err,
    );
    expect(failure.message).toMatch(/FOREIGN listener/);
    expect(failure.message).toContain(String(port));
    // The wording a reader must NOT be given here: it sends them into src/auth/oauth-flow.ts after
    // a status that code never wrote.
    expect(failure.message).not.toMatch(/expected .*400/i);
  });
});
