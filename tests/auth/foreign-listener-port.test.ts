// #48: a process outside the suite listening inside the band 20000-29999 used to be handed out by
// freePort(), and reddened a run that had nothing to do with the test (`next-server` on *:20127).
//
// Structural, not statistical: the foreign listener is placed on a KNOWN band port and the scan is
// pointed straight at it, so the case is reached on every run rather than waited for.
import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { freePort, portClaimPath, startScanAt } from './login-harness.js';

// Binds every interface, as src/auth/oauth-flow.ts does.
function bind(port: number): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

describe('freePort() and a foreign listener in the band', () => {
  const opened: Server[] = [];
  afterEach(() => {
    for (const s of opened.splice(0)) s.close();
  });

  it('skips a band port held without a claim, and returns one that binds', async () => {
    // A band port with a listener and NO claim file — what a foreign process looks like from here.
    const foreign = freePort();
    rmSync(portClaimPath(foreign), { force: true });
    opened.push(await bind(foreign));

    startScanAt(foreign);
    const port = freePort();

    expect(port).not.toBe(foreign);
    opened.push(await bind(port));
  });
});
