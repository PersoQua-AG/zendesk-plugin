// #48, round two. Two rules the fix added are pinned here, both by behaviour.
//
// TMPDIR is re-pointed before the harness is imported, so the 64 listeners this file puts up and
// the claims they cost live in a claim directory nobody else shares; vitest's default pool runs
// each test file in its own process (vitest.config.ts names no pool), so that env write reaches
// nobody else.
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer, type Server } from 'node:net';
import { allowForeignBind } from '../setup/acquired-ports.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The claim directory every OTHER run of this user shares. The 64 listeners below are real
// sockets on real band ports, so a concurrent test file would see them as strangers, probe them
// and spend its own budget on them — measured: it ends in the budget refusal. They are therefore
// claimed THERE for the lifetime of this file, which is what makes a concurrent acquirer skip them
// for a link() and no probe, and released in afterAll.
const SHARED_CLAIM_DIR = join(tmpdir(), 'zendesk-plugin-test-ports');

const ISOLATED_TMP = mkdtempSync(join(tmpdir(), 'port-probe-budget-'));
process.env.TMPDIR = ISOLATED_TMP;
const harness = await import('./login-harness.js');

const reservedElsewhere: string[] = [];
function reserveForOtherRuns(port: number): void {
  const path = join(SHARED_CLAIM_DIR, String(port));
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' });
    reservedElsewhere.push(path);
  } catch {
    // Already claimed by somebody else — then they are not going to probe it either.
  }
}

const opened: Server[] = [];
afterAll(() => {
  for (const path of reservedElsewhere.splice(0)) rmSync(path, { force: true });
});
afterEach(async () => {
  for (const s of opened.splice(0)) {
    s.close();
    await once(s, 'close');
  }
});

// A listener on a band port with no claim on it — what a stranger looks like from here. The claim
// is held while the socket comes up so no concurrent acquirer can be handed the port in between.
async function strangerOn(port: number): Promise<void> {
  mkdirSync(SHARED_CLAIM_DIR, { recursive: true });
  reserveForOtherRuns(port);
  writeFileSync(harness.portClaimPath(port), String(process.pid), { flag: 'wx' });
  const s = createServer();
  // A port a run outside this file already listens on is ALREADY what this call is trying to make
  // it — measured: without this the case reddens roughly one run in three on a machine running the
  // suite concurrently, which is the very flakiness #48 is about.
  s.on('error', () => {});
  // Declared to the bind-time guard (#74): a stranger is the fixture here, not a mistake.
  allowForeignBind(port, 'a stranger planted in front of the probe budget');
  s.listen(port);
  try {
    await once(s, 'listening');
    opened.push(s);
  } catch {
    // Taken by somebody else. Nothing to put up here, and nothing to take down.
  }
  rmSync(harness.portClaimPath(port), { force: true });
}

describe('the probe never collides with its own sockets', () => {
  // The sibling case in foreign-listener-port.test.ts asks about the three REAL addresses, and on
  // macOS that question cannot see an overlap: SO_REUSEADDR lets a wildcard socket and a specific
  // one hold the same port. Asking for the SAME address three times removes that cover — two binds
  // of 127.0.0.1 collide on macOS exactly as they do on Linux — so a sequential probe answers ''
  // and every overlapping shape answers '127.0.0.1', on both platforms.
  //
  // Measured against the b940a9d defect rebuilt to satisfy the source-text guard in
  // foreign-listener-port.test.ts:92-100: that shape is green on macOS and red on Linux for the
  // three real addresses, and red on BOTH here.
  it('answers a free port free even when asked for one address three times', () => {
    const port = harness.freePort();
    expect(harness.portHeldOn(port, ['127.0.0.1', '127.0.0.1', '127.0.0.1'])).toBe('');
  }, 120_000);
});

describe('the probe budget', () => {
  // MAX_PROBES_PER_ACQUISITION bounds the blocked event loop, and that is worth having. What it
  // must not do is refuse while the very next candidate is free: the claims the rejected ports keep
  // (login-harness.ts:289-291) mean no second pass repeats any of that work, so giving up costs a
  // red run for nothing. Measured on the shipped shape: 64 strangers in front, freePort() throws
  // "gave up after probing 64 band ports", portHeldOn() on the next candidate returns '', and the
  // immediately following freePort() succeeds. A failure a retry undoes is a flake, and which
  // worker hits it is decided by `nextCandidate = process.pid % PORT_BAND_SIZE`.
  it('does not refuse while the band behind the strangers is free', async () => {
    const first = harness.freePort() + 1;
    for (let i = 0; i < harness.MAX_PROBES_PER_ACQUISITION; i += 1) await strangerOn(first + i);

    let refusal: Error | undefined;
    let port = 0;
    try {
      port = harness.freePort();
    } catch (err) {
      refusal = err as Error;
    }

    expect(
      refusal?.message ?? '(returned a port)',
      `the next candidate after the budget was ${harness.portHeldOn(first + harness.MAX_PROBES_PER_ACQUISITION) === '' ? 'FREE' : 'held'}`,
    ).toBe('(returned a port)');
    expect(port).toBeGreaterThanOrEqual(harness.PORT_BAND_FIRST);
  }, 600_000);
});
