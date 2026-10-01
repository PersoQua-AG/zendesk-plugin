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
import { freePort, portClaimPath } from './login-harness.js';

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

  // #13: the probe may never run before the claim is held, or the gap between the probe's close and
  // the caller's bind becomes a port the next acquirer can be handed. Source, because the window it
  // guards is not observable from inside one process.
  it('binds nothing before the claim is taken (#13)', () => {
    const harness = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'login-harness.ts'), 'utf8');
    const body = /export function freePort\(\): number \{[\s\S]*?\n\}/.exec(harness)?.[0] ?? '';
    expect(body, 'freePort() not found').not.toBe('');
    expect(body.indexOf('claimPort(')).toBeLessThan(body.indexOf('portHeldOn('));
  });
});
