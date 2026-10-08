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
import { allowForeignBind } from '../setup/acquired-ports.js';

// The body of a named function in the harness source, for the two cases whose rule is not
// observable from inside one process.
function harnessFunction(name: string): string {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'login-harness.ts'), 'utf8');
  const body = new RegExp(`export function ${name}\\([^]*?\\n\\}`).exec(source)?.[0] ?? '';
  expect(body, `${name}() not found in login-harness.ts`).not.toBe('');
  return body;
}

async function bind(port: number, host?: string): Promise<Server> {
  // Declared to the bind-time guard (#74): this file exists to put up a listener freePort() did NOT
  // hand out — `freePort() + 1` is its subject, not an accident — so the refusal has to be told.
  allowForeignBind(port, 'the foreign listener #48 is about, deliberately outside the allocator');
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
  //
  // The candidate freePort() will examine next is the one it just returned plus one — nextCandidate
  // advances by exactly one per candidate. That port can already be claimed or already be listened
  // on by another run of this user (measured: port-probe-budget.test.ts reserves 64 of them, and
  // the collision reddened this file). Then it is not ours to make a stranger of, and freePort()
  // would skip it for a link() anyway, so the next candidate is tried instead.
  async function foreignListenerOnNextCandidate(host?: string): Promise<number> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const next = freePort() + 1;
      try {
        writeFileSync(portClaimPath(next), String(process.pid), { flag: 'wx' });
      } catch {
        continue;
      }
      try {
        opened.push(await bind(next, host));
      } catch {
        rmSync(portClaimPath(next), { force: true });
        continue;
      }
      rmSync(portClaimPath(next), { force: true });
      return next;
    }
    return expect.fail('no band port free to put a stranger on in 20 attempts');
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
  // as a holder spends the whole probe budget on a condition of the HOST. 192.0.2.1 is TEST-NET-1
  // and is bindable nowhere: EADDRNOTAVAIL on macOS and on Linux, measured.
  it('does not read a bind error other than EADDRINUSE as a holder', () => {
    expect(() => portHeldOn(freePort(), ['192.0.2.1'])).toThrow(/EADDRNOTAVAIL/);
  });

  // #13: the probe may never run before the claim is held, or the gap between the probe's close and
  // the caller's bind becomes a port the next acquirer can be handed. Source, because the window it
  // guards is not observable from inside one process.
  it('binds nothing before the claim is taken (#13)', () => {
    // Comments stripped first: this file's own rule names both functions in prose above the code.
    const body = harnessFunction('freePort').replace(/^\s*\/\/.*$/gm, '');
    expect(body.indexOf('if (!claimPort(port)) continue;')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('if (!claimPort(port)) continue;')).toBeLessThan(body.indexOf('portHeldOn(port)'));
  });
});
