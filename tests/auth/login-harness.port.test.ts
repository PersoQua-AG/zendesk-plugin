import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createServer, type RequestListener, type Server } from 'node:http';
import {
  PORT_BAND_FIRST,
  PORT_BAND_LAST,
  answerFromOurListener,
  closeRawSockets,
  freePort,
  pidIsLive,
  portClaimPath,
  sweepDeadClaims,
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

// The sweep is the one thing in the claim that DELETES, so the only way it can hand a port out
// twice is by calling something live dead. The two kinds of entry it meets are judged by different
// rules, and the reason is a defect this pins: a staging file legitimately exists with no content
// yet, because `wx` create and the pid write are two syscalls. Judging it by content read the '' in
// between, called it ownerless and removed it, and the owner's linkSync then failed with ENOENT.
//
// Each case below states one rule of the sweep against the real sweepDeadClaims(), deterministically
// — it plants the state and calls the sweep, rather than racing for it. Only entries this test owns
// are planted: a staging name is a UUID, and a claim is one freePort() handed us. Deterministic
// in its verdict, not in who acts: a concurrent run's sweep may reclaim a planted claim first.
describe('the sweep that reclaims the band', () => {
  const claimDir = dirname(portClaimPath(PORT_BAND_FIRST));
  const planted: string[] = [];

  function plantStaging(contents: string, ageMs = 0): string {
    const path = join(claimDir, `.staging-${randomUUID()}`);
    writeFileSync(path, contents, { flag: 'wx' });
    if (ageMs > 0) {
      const when = (Date.now() - ageMs) / 1000;
      utimesSync(path, when, when);
    }
    planted.push(path);
    return path;
  }

  // Shared claim dir: a concurrent run may reclaim and reissue this port (#38); assert the owner.
  // Another checkout's sweep can pass this without ours acting; one run still pins it.
  function claimOwner(path: string): string | null {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** The inode a claim is published under, or null if it is already gone. One stat(2), so there is
   * no check-then-use window; every non-ENOENT error still throws. */
  const inodeOf = (claim: string): number | null => statSync(claim, { throwIfNoEntry: false })?.ino ?? null;

  /**
   * The claim's inode, with that inode HELD OPEN under a second name until afterEach drops it.
   *
   * The pin is the whole point. `linkSync` does not mint a new inode — it shares the one it links
   * to — so "the inode under this name changed" means "removed and republished" only for as long
   * as the old NUMBER cannot come back. APFS hands a just-freed inode number straight out again,
   * and the staging file a concurrent `claimPort()` creates is precisely the next allocation: a
   * flake built into the branch whose job is to remove flakes. A second link keeps the number
   * allocated, so nothing created after this call can be given it.
   *
   * OUTSIDE CLAIM_DIR, in a directory of this file's own. Inside it the pin is just another entry
   * for `sweepDeadClaims()` to judge: it carries the claim's own dead-or-empty pid and does not
   * start with STAGING_PREFIX, so the very sweep under test removed it, the inode was freed
   * anyway, and the guarantee in this comment was false. Same tmpdir, so `linkSync` stays on one
   * filesystem.
   *
   * It throws `AlreadyGone` rather than returning null when the claim is no longer the one that
   * was planted. Its caller retries on that; what must never happen is a null flowing into the
   * assertion, where `expect(x).not.toBe(null)` is true of any file at all and the check degrades
   * to nothing without saying so.
   */
  class AlreadyGone extends Error {}

  function pinInode(claim: string): { inode: number; pin: string } {
    const ino = inodeOf(claim);
    if (ino === null) throw new AlreadyGone(`nothing to pin: ${claim} was gone before the sweep`);
    const pin = join(tmpdir(), `claim-inode-pin-${randomUUID()}`);
    try {
      linkSync(claim, pin);
    } catch (err) {
      // The name went between the stat and the link. Every other errno — EXDEV, EACCES, EMLINK,
      // ENOSPC — is a real failure and must not be retried ten times and then misreported as a
      // race, which is what a bare `catch {}` in the caller did.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AlreadyGone(`${claim} was gone before the link`);
      throw err;
    }
    planted.push(pin);
    // AND THE PIN HAS TO HOLD THE INODE WE MEASURED. Between the stat above and this link a foreign
    // worker can sweep the dead-owner body AND republish the name through its own claimPort(), so
    // the link lands on a DIFFERENT file than the stat read, `pinInode` returns the old number
    // while the pin holds the new one, and the anti-recycling guarantee in this docstring is void.
    //
    // The comparison is on the INODE, not on the claim's owner. An owner re-read was the first
    // spelling and it asks the wrong object: if the foreign re-claimer exits between the link and
    // the read, its pid is no longer live, nothing is thrown, and the mismatch stands. This does
    // not depend on a third party still being alive.
    if (statSync(pin).ino !== ino) {
      throw new AlreadyGone(`${claim} was republished between the stat and the link`);
    }
    return { inode: ino, pin };
  }

  /**
   * Acquires a port, writes the fixture body into its claim and pins the inode, taking a FRESH
   * port each time the two steps are raced.
   *
   * Every vitest worker sweeps at module load (login-harness.ts:149), so between writing an
   * ownerless or dead-owner body and taking the pin link, another worker can reclaim the name —
   * measured as `nothing to pin: …/25203 was gone before the sweep`.
   *
   * A FRESH PORT PER ATTEMPT, never a second write to the same name. Retrying onto the old one was
   * a truncating write onto a name that, by the retry's own premise, a foreign sweep had just
   * freed and a foreign `claimPort()` may already have republished: it would have overwritten a
   * LIVE worker's claim with a dead-pid body, and the next sweep would then free a port that
   * worker is bound to — the #13 double handout this file exists to prevent. Straight after
   * `freePort()` the claim carries this process's own live pid, so it is ours to overwrite and no
   * foreign sweep can judge it dead.
   */
  function plantAndPin(body: string): { claim: string; inode: number; pin: string } {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const claim = portClaimPath(freePort());
      writeFileSync(claim, body);
      try {
        return { claim, ...pinInode(claim) };
      } catch (err) {
        if (!(err instanceof AlreadyGone)) throw err;
        // Swept between the write and the link. That port is now somebody else's business.
      }
    }
    throw new Error('could not plant and pin a claim: ten ports in a row were raced away');
  }

  function expectReclaimed(claim: string, plantedOwner: string, inodeBefore: number): void {
    const owner = claimOwner(claim);
    if (owner === null) return;
    expect(owner).toMatch(/^\d+$/);
    expect([String(process.pid), plantedOwner]).not.toContain(owner);
    expect(pidIsLive(Number(owner))).toBe(true);
    // REMOVAL, not a rewrite (#52). Everything above is also true of a sweep that OVERWRITES the
    // claim in place with any live third pid, which is not reclamation at all: the dead owner's
    // name was never freed. The inode tells the two apart: an in-place overwrite keeps it, while
    // the only legitimate way this name can carry a foreign owner is a concurrent run's
    // claimPort() publishing a DIFFERENT file by linkSync (login-harness.ts:172) after the
    // removal. `inodeBefore` comes from pinInode(), which is what makes "different" safe to read
    // off the number alone. Measured: mutations O1 ('1') and O2 (process.ppid) survived every
    // assertion above with 9 passed, and are red on this line.
    expect(inodeOf(claim)).not.toBe(inodeBefore);
  }

  afterEach(() => {
    for (const path of planted.splice(0)) rmSync(path, { force: true });
  });

  // The defect itself. A staging file mid-write is EMPTY and LIVE at the same time, and the sweep
  // must keep it. Against the pre-fix rule — content for every entry alike — this case is RED.
  it('keeps a staging file that has been created but not yet written', () => {
    const staging = plantStaging('');
    sweepDeadClaims();
    expect(existsSync(staging)).toBe(true);
  });

  // The content of a staging file is never the sweep's business, so not even a garbage pid in one
  // may condemn it. This pins the rule as "by name, then age" rather than "empty is tolerated".
  it('keeps a staging file whose content could not name an owner', () => {
    const staging = plantStaging('not-a-pid');
    sweepDeadClaims();
    expect(existsSync(staging)).toBe(true);
  });

  // Age is the ONLY thing that condemns a staging file, so an abandoned one is still reclaimed —
  // the rule buys the owner a window, it does not leak the directory. MAX_CLAIM_AGE_MS is 30 min.
  // The path check is safe here: a staging name is a UUID, so no other run can reissue it.
  it('reclaims a staging file left behind by a run that died', () => {
    const staging = plantStaging('', 31 * 60_000);
    sweepDeadClaims();
    expect(existsSync(staging)).toBe(false);
  });

  // And the content rule still stands where it is correct. A claim is published by link(), so it is
  // never observable half-written: one that reads empty has no owner and must be gone afterwards or
  // taken over by a live foreign process, or the band fills up with claims nothing holds. This is
  // the half the fix must NOT have loosened.
  it('reclaims a claim that names no owner', () => {
    const { claim, inode } = plantAndPin('');
    sweepDeadClaims();
    expectReclaimed(claim, '', inode);
  });

  // The pin has to survive the sweep it is pinning ACROSS, or it pins nothing. Its first spelling
  // put the link inside CLAIM_DIR, where it is simply another entry: it carried the claim's own
  // dead-or-empty pid, did not start with STAGING_PREFIX, and `sweepDeadClaims()` removed it in the
  // same call — the inode was freed anyway and the guarantee was false while reading as true.
  it('holds the pinned inode across the sweep, which is the only thing that makes the check real', () => {
    const { pin } = plantAndPin('');

    sweepDeadClaims();

    expect(existsSync(pin), 'the pin was swept with the claim').toBe(true);
  });

  it('reclaims a claim whose owner has exited, and keeps one whose owner is alive', () => {
    const dead = spawnSync(process.execPath, ['-e', '0']);
    expect(dead.pid).toBeGreaterThan(0);

    const ours = portClaimPath(freePort());
    const { claim: abandoned, inode } = plantAndPin(String(dead.pid));

    sweepDeadClaims();

    expectReclaimed(abandoned, String(dead.pid), inode);
    // Ours names a pid that is this very process, so nothing about it can read as dead.
    expect(readFileSync(ours, 'utf8')).toBe(String(process.pid));
  });

  // The EPERM branch of pidIsLive (login-harness.ts:118), which decides every "keeps one whose
  // owner is alive" above and was pinned by nothing: a catch returning plain `false` read a live
  // process owned by ANOTHER USER as dead, and its claim was then reclaimed under it. pid 1 is the
  // init process and belongs to root, so kill(1, 0) from an unprivileged process answers EPERM —
  // the one liveness answer that arrives as a thrown error.
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'reads a process it may not signal as alive, because EPERM means it is there',
    () => {
      expect(pidIsLive(1)).toBe(true);
    },
  );
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
