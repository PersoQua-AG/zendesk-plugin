// #48: a process outside the suite listening inside the band 20000-29999 used to be handed out by
// freePort(), and reddened a run that had nothing to do with the test (`next-server` on *:20127).
//
// Structural, not statistical: `nextCandidate` advances by exactly one per candidate examined, so
// the port freePort() will look at NEXT is the one it just returned plus one. The foreign listener
// goes there, and the case is reached on every run rather than waited for.
import { describe, it, expect, afterEach } from 'vitest';
import { once } from 'node:events';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, portClaimPath, portHeldOn } from './login-harness.js';

// The body of a named function in the harness source, for the two cases whose rule is not
// observable from inside one process.
function harnessFunction(name: string): string {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'login-harness.ts'), 'utf8');
  const body = new RegExp(`export function ${name}\\([^]*?\\n\\}`).exec(source)?.[0] ?? '';
  expect(body, `${name}() not found in login-harness.ts`).not.toBe('');
  return body;
}

async function bind(port: number, host?: string): Promise<Server> {
  const server = host === undefined ? createServer().listen(port) : createServer().listen(port, host);
  await once(server, 'listening');
  return server;
}

describe('freePort() and a foreign listener in the band', () => {
  const opened: Server[] = [];
  afterEach(async () => {
    for (const s of opened.splice(0)) {
      s.close();
      await once(s, 'close');
    }
  });

  // The listener is put up while a claim of this process holds the port, so no concurrent run can
  // be handed it in between; the claim comes off afterwards, which is what makes it look foreign.
  async function foreignListenerOnNextCandidate(host?: string): Promise<number> {
    const next = freePort() + 1;
    writeFileSync(portClaimPath(next), String(process.pid), { flag: 'wx' });
    opened.push(await bind(next, host));
    rmSync(portClaimPath(next), { force: true });
    return next;
  }

  // Every address a stranger can hold the port on. Only the first collides with the production
  // bind; for the other three that bind SUCCEEDS and the more specific socket takes the traffic —
  // measured, with no EADDRINUSE anywhere, which is the quiet half of #48.
  for (const host of [undefined, '0.0.0.0', '127.0.0.1', '::1']) {
    it(`skips a band port held on ${host ?? 'the wildcard'} without a claim`, async () => {
      const foreign = await foreignListenerOnNextCandidate(host);
      const port = freePort();
      expect(port).not.toBe(foreign);
      opened.push(await bind(port));
    });
  }

  // The probe must not collide with ITSELF. Overlapping the three binds is harmless under macOS's
  // SO_REUSEADDR and is EADDRINUSE on Linux, where the overlapping shape called EVERY free port
  // held on 127.0.0.1 and walked the band to its end — CI run 36845405954 on b940a9d printed
  // 44 724 skips and then declared the band exhausted. This case is red on Linux against that
  // shape and GREEN on macOS, where the defect does not exist: it holds the rule on ubuntu-latest,
  // which is where CI runs, and the platform pair is in the comment above portHeldOn().
  it('does not call a port nobody holds held', () => {
    expect(portHeldOn(freePort())).toBe('');
  });

  // Only EADDRINUSE means a stranger. Any other bind error is "I could not look", and reading it
  // as a holder burns one claim per candidate for the whole band. 192.0.2.1 is TEST-NET-1 and is
  // bindable nowhere: EADDRNOTAVAIL on macOS and on Linux, measured.
  it('does not read a bind error other than EADDRINUSE as a holder', () => {
    expect(() => portHeldOn(freePort(), ['192.0.2.1'])).toThrow(/EADDRNOTAVAIL/);
  });

  // #13: the probe may never run before the claim is held, or the gap between the probe's close and
  // the caller's bind becomes a port the next acquirer can be handed. Source, because the window it
  // guards is not observable from inside one process.
  it('binds nothing before the claim is taken (#13)', () => {
    const body = harnessFunction('freePort');
    expect(body.indexOf('claimPort(')).toBeLessThan(body.indexOf('portHeldOn('));
  });

  // Also source, and for the same reason the case above is: the behaviour this pins — the probe's
  // own sockets must not overlap — is invisible on macOS, where SO_REUSEADDR permits the overlap.
  // The behavioural case ('does not call a port nobody holds held') only goes red on Linux, so
  // rebuilding the overlap on a developer machine would otherwise look green, and it looked green
  // for a whole round before CI run 36845405954 found it. Each address must be awaited up and
  // closed down before the next one is opened.
  it('probes its addresses one at a time, never overlapping them (CI 36845405954)', () => {
    const body = harnessFunction('portHeldOn');
    const loop = /for\(const h of[^]*?\}process\.exit\(0\)/.exec(body)?.[0] ?? '';
    expect(loop, 'the probe loop is not in the shape this case can read').not.toBe('');
    expect(loop, 'the bind must be awaited before the next address').toMatch(/await once\(s,'listening'\)/);
    expect(loop, 'the socket must be closed and awaited before the next address').toMatch(
      /s\.close\(\);await once\(s,'close'\)/,
    );
  });
});
