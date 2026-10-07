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
import { PORT_BAND_FIRST, PORT_BAND_LAST, freePort, portClaimPath, portHeldOn } from './login-harness.js';

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
  //
  // The candidate freePort() will examine next is the one it just returned plus one — nextCandidate
  // advances by exactly one per candidate. That port can already be claimed, or already be listened
  // on, by another run of this user; then it is not ours to make a stranger of and the walk below
  // steps to the one after it.
  //
  // THE CURSOR MOVES BY ONE, SO THE WALK MOVES BY ONE (#106 finding 3). The attempt log below was
  // added first and answered the question in one run: every one of the twenty attempts failed with
  // `claim EEXIST`, and the ports stepped by exactly TWO —
  //   host ::1: 23233 claim EEXIST, 23235 claim EEXIST, 23237 claim EEXIST, … 23271 claim EEXIST
  // Not the 64 reservations of port-probe-budget, which the ticket suspected, and not a stranger
  // anywhere: two concurrent acquirers in LOCKSTEP. The old loop answered an occupied candidate by
  // calling freePort() AGAIN, which advances the shared band cursor by one and so the candidate by
  // two — straight onto the claim the other run had just taken for itself, every time.
  //
  // Walking forward by one costs no extra attempts and no luck. Every port skipped here is one
  // another run has CLAIMED, and freePort() skips a claimed port for a link() and no probe at all,
  // so its walk still arrives at exactly the port the stranger is put on — which is the property
  // this file exists to hold, kept structural rather than made statistical. The bound is the band
  // itself, and running out of band is a different sentence with a different cause.
  //
  // THE ATTEMPT LOG STAYS. It is what turned "20 attempts" from a count into a measurement, and
  // the next failure here has to arrive with its ports and its reasons attached.
  async function foreignListenerOnNextCandidate(host?: string): Promise<number> {
    const refused: string[] = [];
    const anchor = freePort();
    // IT WRAPS, like the cursor it follows. `for (next = anchor + 1; next <= PORT_BAND_LAST)` ran
    // zero times when freePort() returned the last port of the band, and the case then failed
    // unconditionally with an empty log and the nonsense "between 30000 and 29999". freePort()
    // itself wraps (`PORT_BAND_FIRST + nextCandidate % PORT_BAND_SIZE`), and the 20-attempt loop
    // this replaced inherited that wrap; a band edge is roughly 1 pid residue in 10 000, which is
    // exactly the kind of rate that reaches somebody else and not you.
    const bandSize = PORT_BAND_LAST - PORT_BAND_FIRST + 1;
    for (let step = 1; step <= bandSize; step += 1) {
      const next = PORT_BAND_FIRST + ((anchor - PORT_BAND_FIRST + step) % bandSize);
      try {
        writeFileSync(portClaimPath(next), String(process.pid), { flag: 'wx' });
      } catch (err) {
        refused.push(`${next} claim ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
        continue;
      }
      try {
        opened.push(await bind(next, host));
      } catch (err) {
        rmSync(portClaimPath(next), { force: true });
        refused.push(`${next} bind ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
        continue;
      }
      rmSync(portClaimPath(next), { force: true });
      return next;
    }
    return expect.fail(
      `no band port left to put a stranger on in ${PORT_BAND_FIRST}-${PORT_BAND_LAST}, walking ` +
        `from ${anchor + 1} (host ${host ?? 'wildcard'}): ${refused.join(', ')}`,
    );
  }

  // Every address a stranger can hold the port on. Only the first collides with the production
  // bind; for the other three that bind SUCCEEDS and the more specific socket takes the traffic —
  // measured, with no EADDRINUSE anywhere, which is the quiet half of #48.
  for (const host of [undefined, '0.0.0.0', '127.0.0.1', '::1']) {
    // WHAT THIS CASE PROVES, AND WHERE THE REST IS PROVED. It asserts the #48 property
    // unconditionally: a band port held without a claim is not handed out. It does NOT prove that
    // freePort() *examined* that particular port, and under concurrency it cannot — measured.
    //
    // Two attempts to assert the examination here both flaked, and the second one is the reason
    // this comment exists rather than a third. freePort() announces each skip on stderr, so an
    // assertion on that line looked exact; but another run can claim `foreign` in the window
    // between this helper's `rmSync` of its own claim and freePort()'s `claimPort`, and freePort()
    // then skips the stranger for a link() with no probe and no line. Instrumented:
    //   DIAG foreign=27115 returned=27116 steppedOver=[27114] claim held by pid 17114, me 17113
    // Adding a disjunct for "a port the walk stepped over" did not cover that cell and the full
    // suite went red in 2 of 5 runs — a flake introduced by the ticket whose subject is flakes.
    //
    // So the examination is pinned where it can be deterministic, and it is pinned:
    //   - that a stranger IS seen, per address: 'does not call a port nobody holds held' below,
    //     tests/auth/port-probe-routable.test.ts, and the platform matrix above portHeldOn;
    //   - that freePort() consults portHeldOn AFTER taking the claim and before returning:
    //     'binds nothing before the claim is taken (#13)' below, read from the source because the
    //     window is not observable from inside one process.
    // Those two together are the property, without a race in the assertion.
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
