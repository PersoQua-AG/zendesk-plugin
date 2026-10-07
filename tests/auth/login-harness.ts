// Shared fixture for the three zendesk_login suites. It held three wordlike-identical copies of
// freePort/config/deps/authorizationUrl and of the beforeEach/afterEach pair; the afterEach in
// particular is load-bearing — runLogin keeps its flow in module state, so a case that leaves a
// listener bound makes the NEXT case depend on the order it ran in.
import { expect, beforeEach, afterEach, vi } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { abortLoginFlow, type LoginDeps } from '../../src/tools/login.js';
import type { OAuthConfig } from '../../src/auth/oauth-flow.js';

export const SECRET = 'secret-xyz';

// Live bindings: re-pointed by the beforeEach below, read by every importing suite.
export let dataDir: string;
export let tokensPath: string;

// ---------------------------------------------------------------------------------------------
// Port acquisition (#13).
//
// The old shape bound port 0, read the number the OS assigned, CLOSED that listener and returned
// the number; the caller bound it afterwards. Between the close and the caller's listen the port
// belonged to nobody, and the OS was free to hand it to the next listen(0) anywhere on the machine.
// It did: #13 records a raw request answered 404 on /callback — a status our own listener cannot
// produce on that path — and, from the same window, a callback a foreign listener swallowed.
//
// The window is not narrowed here, it is removed: NOTHING below binds a socket, so there is nothing
// to close and no moment at which the port is handed back. A port is acquired by
//
//   1. drawing it from a band no OS ephemeral allocator draws from (macOS and Windows start at
//      49152, Linux at 32768), so no listen(0) — in this run, in a parallel `vitest run`, or in any
//      other process on this machine — can ever be given one of these numbers; and
//   2. claiming it in a directory under the system temp dir, with an atomic test-and-set, because
//      the collision spanned processes: vitest runs each test file in its own process, and a second
//      checkout runs its own vitest. The reach of that claim is every run of THIS USER on this
//      machine — tmpdir() is per-user on macOS (/var/folders/…/T) — so two different users can
//      still be handed the same number. That surfaces as a named EADDRINUSE on the production
//      bind, not as the silent wrong-listener answer this issue is about.
//
// Handing the BOUND listener through instead — the other shape #13 offers — is not available: two
// sockets cannot hold one port, and the production listener binds the number itself
// (src/auth/oauth-flow.ts, `server.listen(port)`), which no test may change.
//
// What a claim cannot see: a foreign process holding a band port (#48 — an unrelated `next-server`
// on *:20127 reddened a run). portHeldOn() below narrows that AFTER the claim is held. What it does
// not narrow is the moment between its probe and the production bind; that remnant stays what line
// 41 describes — a named EADDRINUSE, loud.
export const PORT_BAND_FIRST = 20_000;
export const PORT_BAND_LAST = 29_999;
const PORT_BAND_SIZE = PORT_BAND_LAST - PORT_BAND_FIRST + 1;

const CLAIM_DIR = join(tmpdir(), 'zendesk-plugin-test-ports');

// The proof that a port is held, as a path a test can read: freePort() returns only once this file
// exists and names the process that owns it.
export function portClaimPath(port: number): string {
  return join(CLAIM_DIR, String(port));
}

// A claim older than this is wreckage even when its pid still answers: pids are reused, and a claim
// held by an unrelated live process would otherwise hold its port for the lifetime of the machine.
// The ceiling is a time ASSUMPTION, and it is the one number here that can hand a port out twice —
// a run that outlived it would have a LIVE claim swept. So the margin, measured: the whole suite
// takes 15.5 s (15.34 s under coverage), and the slowest single file holding a claim ~5.2 s. Thirty
// minutes is a factor of more than a hundred. The one process that can outlive it is `test:watch`,
// and the claims ageing out there belong to earlier passes whose listeners are long closed.
const MAX_CLAIM_AGE_MS = 30 * 60_000;

// What marks an entry as a staging file rather than a claim. Claims are named by their port number,
// so no claim can collide with it.
const STAGING_PREFIX = '.staging-';

// Two kinds of entry live here, and they are NOT judged the same way.
//
// A CLAIM stands only if it is both young enough to belong to a running suite and owned by a
// process that still exists. Either half alone leaks the band — the first to killed runs, the
// second to reused pids. `kill(pid, 0)` sends no signal, it only asks; EPERM means the process
// exists and is someone else's, which is alive. Reading a claim's content is safe because link()
// only ever publishes a finished one.
//
// A STAGING file is judged by its AGE ALONE, because it is the one entry that legitimately exists
// with no content yet: `wx` create and the pid write are two syscalls, and a sweep that read the ''
// in between deleted a LIVE staging file out from under its owner, whose linkSync then failed with
// ENOENT and took freePort() down with it. Measured across two concurrent suite runs: three of five
// failures were exactly that. A staging file carries its purpose in its NAME; its content is
// nobody's business but its owner's.
function entryIsLive(entry: string, path: string): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    // Swept by another run between the readdir and the stat. Nothing left to keep.
    return false;
  }
  // A clock that moved backwards makes `age` negative: young, which keeps the entry and lets the
  // owner rule below decide. Never dead by arithmetic.
  if (age >= MAX_CLAIM_AGE_MS) return false;
  if (entry.startsWith(STAGING_PREFIX)) return true;

  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
  } catch {
    // Gone, unreadable, or a directory: the mkdir-shaped claim this replaced reads as EISDIR here.
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return pidIsLive(pid);
}

export function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Vitest ends its worker processes with a signal, so 'exit' hooks do not run and nothing releases a
// claim at the end of a case. Reclamation is therefore the ONLY release: every process sweeps what
// dead ones left before it takes anything. Measured without it: 779 claims after seven runs, and a
// band exhausted after roughly ninety.
export function sweepDeadClaims(): void {
  let entries: string[];
  try {
    entries = readdirSync(CLAIM_DIR);
  } catch {
    // No claim dir yet, or it is unreadable: nothing to sweep, and claimPort reports the unreadable
    // case with the path in the message.
    return;
  }
  for (const entry of entries) {
    const path = join(CLAIM_DIR, entry);
    try {
      // `force` so an entry another sweep removed first is not an error, and `recursive` so a claim
      // left by the mkdir shape this replaced goes too.
      if (!entryIsLive(entry, path)) rmSync(path, { recursive: true, force: true });
    } catch {
      // A concurrent run swept the same entry first. Not ours to report.
    }
  }
}

sweepDeadClaims();

// A claim must NEVER be observable without its owner: one that can be read empty is one a
// concurrent sweep calls ownerless and removes, and then the port goes out twice — the defect this
// replaces, in a narrower window. So the pid is written under a private staging name FIRST and the
// finished file is hard-linked into place: link() fails with EEXIST when the name is taken, which
// makes publishing the owner and taking the name one event. (Create-then-write cannot: measured,
// `printf "" > $T/20002/pid` was swept despite a fresh mtime.) Hard links need one filesystem, so
// staging lives in CLAIM_DIR; on Windows they are not universal, and CI is ubuntu-latest.
//
// The staging name is random AND created exclusively, and it starts with STAGING_PREFIX so the
// sweep above can tell it from a claim and never read its content. A reused name would be a reused
// inode, and the claim already linked from it would take a fresh mtime and a live owner from a
// write meant for another port — measured on a hand-built collision: `mtime moved: true`. `wx` is
// what makes that
// impossible rather than improbable: the OS refuses the second create instead of the RNG not
// repeating.
function claimPort(port: number): boolean {
  // Cheap enough to repeat (measured: 3.4 µs on a directory that exists) and it is the whole
  // recovery from macOS pruning its per-user temp dir under a running suite — which it did in this
  // session, after which every freePort() threw ENOENT with no way back.
  mkdirSync(CLAIM_DIR, { recursive: true });
  const staging = join(CLAIM_DIR, `${STAGING_PREFIX}${randomUUID()}`);
  writeFileSync(staging, String(process.pid), { flag: 'wx' });
  try {
    linkSync(staging, portClaimPath(port));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw new Error(`could not claim test port ${port} at ${portClaimPath(port)}: ${(err as Error).message}`);
  } finally {
    rmSync(staging, { force: true });
  }
}

// Which address a listener outside this suite holds this port on, '' when nobody does. (#48.)
//
// Runs ONLY on a band port and ONLY once the claim is held, so the #13 window stays shut: nothing
// binds before the claim, and no listen(0) anywhere can be given a band number.
//
// Binding is the only way to ask, and one bind is not enough. Measured, holder down the side:
//
//                      macOS probe        macOS prod. bind   Linux probe        Linux prod. bind
//   holder ::          EADDRINUSE 0.0.0.0 EADDRINUSE         EADDRINUSE 0.0.0.0 EADDRINUSE
//   holder 0.0.0.0     EADDRINUSE 0.0.0.0 succeeds           EADDRINUSE 0.0.0.0 EADDRINUSE
//   holder 127.0.0.1   EADDRINUSE 127.0.0.1 succeeds         EADDRINUSE 0.0.0.0 EADDRINUSE
//   holder ::1         EADDRINUSE ::1     succeeds           EADDRINUSE ::1     EADDRINUSE
//   nobody             free               succeeds           free               succeeds
//
// "prod. bind" is src/auth/oauth-flow.ts:244, `server.listen(port)` with no host. On Linux it is
// loud by itself. On macOS it is the column that MISSES three of the four, because libuv binds TCP
// with SO_REUSEADDR and a wildcard bind therefore succeeds next to a more specific one — which then
// takes the traffic. End to end on macOS: foreign HTTP server on 0.0.0.0:P, ours on the wildcard,
// `GET http://127.0.0.1:P/callback` answered `FOREIGN`, with no EADDRINUSE anywhere. Silent, and
// worse than the case #48 names. That is what the three addresses buy, and none of them is idle.
//
// The addresses are probed ONE AT A TIME, each socket closed before the next opens. Overlapping
// them is what reddened CI on b940a9d: the same SO_REUSEADDR that lets a stranger hide on macOS
// lets the probe's own sockets overlap there, and Linux refuses that — the probe's 127.0.0.1 bind
// took EADDRINUSE from the probe's OWN 0.0.0.0 socket and called a free port held. Measured on the
// same free port, same probe body:
//
//   macOS parallel   -> status 0 ""              Linux parallel   -> status 1 "127.0.0.1"
//   macOS sequential -> status 0 ""              Linux sequential -> status 0 ""
//
// CI run 36845405954 printed 44 724 skips, every one of them 127.0.0.1, and then declared the band
// exhausted.
//
// MEASURED ON BOTH PLATFORMS (#107), which the table above was not — it was reasoned from a
// darwin run. Same script on both sides, one holder at a time on one band port, each of the five
// addresses probed in its own child. darwin 25.3.0 / node v26.5.0; linux via
// `docker run --user node --sysctl net.ipv4.ip_unprivileged_port_start=1024 node:20-bookworm`,
// image node@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5, node
// v20.20.2, one routable address 192.168.215.2. B = the probe BOUND beside the holder,
// X = EADDRINUSE.
//
//   holder \ probe        0.0.0.0   ::   127.0.0.1   ::1   routable
//   darwin
//     no host (wildcard)      X      X        B        B       B
//     0.0.0.0                 X      B        B        B       B
//     ::                      X      X        B        B       B
//     127.0.0.1               B      B        X        B       B
//     routable                B      B        B        B       X
//     nobody                  B      B        B        B       B
//   linux
//     no host (wildcard)      X      X        X        X       X
//     0.0.0.0                 X      X        X        B       X
//     ::                      X      X        X        X       X
//     127.0.0.1               X      X        X        B       B
//     routable                X      X        B        B       X
//     nobody                  B      B        B        B       B
//
// THE DIFFERENCE, stated so the darwin run stops passing for general: on Linux a wildcard probe
// sees EVERY holder — one address would do — because Linux refuses a specific bind that overlaps a
// wildcard one and vice versa. On darwin SO_REUSEADDR allows exactly that, so only the holder's
// OWN address refuses, and a probe set missing an address is BLIND to a holder on it. That is
// #106 finding 2 (the routable row) and its follow-up (the `::` row) in one picture: both are
// invisible on darwin and both are loud on Linux. The address list is therefore sized for darwin
// and merely redundant on Linux, which is the right way round — CI is Linux and the developer
// machine is where the flake was measured.
//
// Also measured in that container, for the OS-chosen-port record this band rests on:
// `net.ipv4.ip_local_port_range = 32768 60999` against PORT_BAND 20000-29999 — no overlap, so the
// record holds there. Both numbers are sysctl-tunable and neither is a guarantee.
//
// A child process, because Node cannot bind a NAMED address synchronously: `listen(port, host)`
// goes through lookupAndListen -> dns.lookup, and `server.listening` is still false when listen()
// returns, even for a free port and a numeric literal host (measured). An async freePort() is not
// available either — it is called from synchronous describe bodies
// (tests/auth/oauth-flow.callback-edges.test.ts:9, tests/auth/oauth-flow.stray-callback.test.ts:35).
//
// Exit 0 = free; 1 = EADDRINUSE, the one error that means a stranger is there; 2 = some other bind
// error. Everything that is not 0 or 1 is "I could not look", and that is NOT an answer: read as
// taken it burns the band one claim at a time (measured with 192.0.2.1, EADDRNOTAVAIL on both
// platforms, which the first shape of this probe reported as a holder), read as free it hands out a
// port a stranger holds. So it throws, and names the probe rather than the claims. Throwing beats
// skipping without a claim: a bind error that is not EADDRINUSE is a property of the HOST, not of
// the port, so every candidate would fail the same way and the band would be walked to the end
// before saying anything.
// `::` IS THE FOURTH ADDRESS, and it was missing. Found by the control run for #106 finding 3:
// `createServer().listen(port)` with no host binds `::` on macOS, and the probe could not see that
// holder at all — 0.0.0.0, 127.0.0.1, ::1 and every routable address below are each a DIFFERENT
// address, and macOS's SO_REUSEADDR lets a specific or differently-scoped wildcard bind succeed
// beside one. Measured: freePort() returned 29559 as free while a concurrent run held `::` on it,
// and the very next `createServer().listen(…)` on that port in the test threw
// `listen EADDRINUSE: address already in use :::29559`. The two wildcards are the two shapes a
// production or test bind with no host actually takes, so both are probed.
const PROBE_ADDRESSES = ['0.0.0.0', '::', '127.0.0.1', '::1'] as const;
const PROBE_TIMEOUT_MS = 2_000;

// THE ROW THE TABLE ABOVE WAS MISSING (#106 finding 2): holder on a ROUTABLE address of this host.
// On macOS all three addresses above stay bindable beside it — the same SO_REUSEADDR that makes the
// wildcard production bind succeed next to a specific socket also lets the 0.0.0.0 PROBE succeed
// next to one — so portHeldOn answered '' FREE and freePort() handed the port out. Measured with a
// foreign listener on 100.107.185.44:51348: status=0, no address named. What then reddens is
// tests/auth/oauth-flow.dual-bind.test.ts:79, which asserts a non-loopback address of this host
// refuses the connection and read 'connected' instead — 1 of 3 full runs.
//
// There is no way to ask for a bind without SO_REUSEADDR from node, so the specific addresses are
// probed one by one, discovered rather than listed. Link-local is left out (an IPv6 scopeid other
// than 0): it needs a scope to bind and is not an address a stranger is reachable on anyway.
//
// NON-STRICT, and that is the whole difference from the three above: a bind error other than
// EADDRINUSE on a discovered address is SKIPPED, not thrown. A deprecated or temporary IPv6
// privacy address answers EADDRNOTAVAIL, and an address this host cannot bind is not one a
// stranger can be listening on either. The strict contract — "I could not look" is never read as
// an answer — stays exactly where it was measured to matter: on the addresses the CALLER names,
// which is what tests/auth/foreign-listener-port.test.ts:92 pins with 192.0.2.1.
function routableAddresses(): string[] {
  const found = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i !== undefined && !i.internal && !(i.family === 'IPv6' && i.scopeid !== 0))
    .map((i) => i!.address);
  return [...new Set(found)];
}

// How many candidates may be PROBED in one pass of freePort() before it moves on. Not how many may
// be examined: a port another run has claimed costs a link() and no probe at all, and the claims
// are what make concurrent runs disagree, so that walk stays uncapped — a fully claimed band is
// 2 774 ms on macOS and 187 ms on Linux of blocked event loop (measured: claimPort() against a
// pre-filled band), which is a cost, not a hazard.
//
// 64 because a probe costs 23.8 ms on macOS and 16.2 ms on Linux (measured, 25 probes each), so one
// pass is at most 1.5 s / 1.0 s and both passes 3.0 s / 2.0 s — the same order as the 5.2 s the
// slowest single file already holds a claim for. Without a ceiling the worst case is
// PORT_BAND_SIZE probes, and with PROBE_TIMEOUT_MS each that is 5.5 hours of blocked event loop
// that no vitest timeout can interrupt. Sixty-four probed band ports all held by strangers is not
// a port problem anyway; #48 was one.
export const MAX_PROBES_PER_ACQUISITION = 64;

export function portHeldOn(port: number, addresses: readonly string[] = PROBE_ADDRESSES): string {
  // [host, strict] — strict hosts throw on a bind error that is not EADDRINUSE, discovered ones
  // are skipped. See routableAddresses() above for why the two classes differ.
  const hosts = [
    ...addresses.map((h) => [h, true] as const),
    ...routableAddresses().map((h) => [h, false] as const),
  ];
  const probe =
    `const n=require('node:net'),{writeSync}=require('node:fs'),{once}=require('node:events');` +
    `(async()=>{for(const [h,strict] of ${JSON.stringify(hosts)}){const s=n.createServer();s.listen(${port},h);` +
    `try{await once(s,'listening')}catch(e){if(e.code==='EADDRINUSE'||strict){` +
    `writeSync(1,e.code+' '+h);process.exit(e.code==='EADDRINUSE'?1:2)}continue}` +
    `s.close();await once(s,'close')}process.exit(0)})()`;
  const run = spawnSync(process.execPath, ['-e', probe], { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' });
  if (run.status === 0) return '';
  if (run.status === 1) return (run.stdout ?? '').split(' ')[1] || 'an address it did not name';
  throw new Error(
    `the port probe for ${port} could not run (status ${run.status}, signal ${run.signal}` +
      `${run.stdout ? `, ${run.stdout}` : ''}${run.error ? `, ${run.error.message}` : ''}) — ` +
      `this is the probe failing, not a stale claim`,
  );
}

// Where this process starts scanning. Only an optimization — the claims, not the offset, are what
// make two acquirers disagree — so that concurrent runs do not walk the same prefix every time.
let nextCandidate = process.pid % PORT_BAND_SIZE;

export function freePort(): number {
  const heldPorts: string[] = [];
  // TWO passes. The first spends the probe budget; every port it rejects KEEPS its claim, so the
  // second walks past all of them for a link() each and spends a fresh budget on ports nobody has
  // probed yet. Without it the refusal landed while the next candidate was free — measured with 64
  // strangers in front: `freePort()` threw, `portHeldOn()` on the very next candidate returned '',
  // and the immediately following `freePort()` succeeded (macOS 26028/26029, Linux 20800/20801).
  // A failure the next call undoes is a flake, and which worker draws it is decided by
  // `nextCandidate = process.pid % PORT_BAND_SIZE` — the same pid positioning #48 is about. This PR
  // may not add one of those.
  let bandExhausted = false;
  for (let pass = 0; pass < 2 && !bandExhausted; pass += 1) {
    let probed = 0;
    let budgetSpent = false;
    for (let tried = 0; tried < PORT_BAND_SIZE; tried += 1) {
      if (probed >= MAX_PROBES_PER_ACQUISITION) {
        budgetSpent = true;
        break;
      }
      const port = PORT_BAND_FIRST + (nextCandidate % PORT_BAND_SIZE);
      nextCandidate += 1;
      // A port another run claimed — or one THIS pass already rejected — costs a link() and
      // nothing else, so it does not count against the probe budget.
      if (!claimPort(port)) continue;
      probed += 1;
      const refusedAt = portHeldOn(port);
      if (refusedAt === '') return port;
      heldPorts.push(`${port} (${refusedAt})`);
      // The claim is KEPT: it names this pid, so it holds the port against every concurrent run for
      // as long as this process lives, and the sweep takes it back once the pid is gone. Releasing
      // it would only make the next acquirer — and the second pass above — pay for the same probe.
      //
      // And it is said out loud, because the staleness assumption at line 69 had exactly one
      // observation that could contradict it — the named EADDRINUSE from src/tools/login.ts:113 —
      // and skipping the port here is what takes that observation away.
      //
      // The address is the FIRST one that refused the bind, which is not always the one the
      // stranger sits on: on Linux any IPv4 holder — wildcard, 0.0.0.0 or 127.0.0.1 — is refused at
      // 0.0.0.0, the first address probed (measured, both platforms; the matrix is above
      // portHeldOn). The wording says that rather than naming an address the holder may not be on.
      process.stderr.write(
        `[test-ports] skipping band port ${port}: a listener outside this suite holds it; first ` +
          `probe address refused: ${refusedAt}\n`,
      );
    }
    bandExhausted = !budgetSpent;
  }
  if (bandExhausted) {
    throw new Error(
      `no unclaimed port left in ${PORT_BAND_FIRST}-${PORT_BAND_LAST}; stale claims under ${CLAIM_DIR}?`,
    );
  }
  throw new Error(
    `gave up after probing ${heldPorts.length} band ports in two passes, from ${heldPorts[0]}, and ` +
      `finding every one of them held: ${heldPorts.slice(0, 5).join(', ')}` +
      `${heldPorts.length > 5 ? ', …' : ''}. That is ${heldPorts.length} of the ${PORT_BAND_SIZE} ` +
      `ports in ${PORT_BAND_FIRST}-${PORT_BAND_LAST}, so it says nothing about the rest of the ` +
      `band. Either this host really has that many foreign listeners, or the probe is answering ` +
      `wrongly — see portHeldOn above; a probe that collides with its own sockets looks exactly ` +
      `like this. The claims this path leaves behind under ${CLAIM_DIR} are live, not stale, while ` +
      `this process runs, and become sweepable wreckage the moment it exits.`,
  );
}

export function config(port: number): OAuthConfig {
  return { subdomain: 'acme', clientId: 'client-abc', clientSecret: SECRET, callbackPort: port, scopes: ['read', 'write'] };
}

export function deps(port: number, overrides: Partial<LoginDeps> = {}): LoginDeps {
  // SECRET doubles as the store key here: the suites verify the file with
  // `new TokenStore(tokensPath, SECRET)`, and one value keeps writer and reader in step. In
  // production the two are unrelated — the key comes from the Keychain (src/auth/store-key.ts).
  //
  // `setup` is here because src/server.ts always carries it for an install whose configuration resolves —
  // a configured one can still be the WRONG one, which is what setup=true is for — so a fixture without it
  // would be a shape the product no longer produces. That lesson cost a round: a defect was "fixed"
  // against a LoginDeps the server could not build, while the server went on answering the old way. The
  // writer throws rather than stores, because none of the flows these suites drive may configure anything.
  return {
    config: config(port),
    tokensPath,
    tokenStoreKey: SECRET,
    setup: {
      writeConfig: () => {
        throw new Error('an ordinary login must never store a configuration');
      },
    },
    ...overrides,
  };
}

// A port made genuinely unavailable to the production listener, which binds 127.0.0.1 AND ::1 since
// #68. ONE wildcard listener is not enough to block it: on macOS a `::` bind does not reserve
// 127.0.0.1 (measured, tests/server-remote/listen-loopback.test.ts:14-16), so the listener would come
// up on the other family and a case meaning to pin a failed bind would pin nothing. Returns the
// release function; a family already covered by the first bind is skipped rather than failed.
export async function occupyPort(port: number): Promise<() => Promise<void>> {
  const held: Server[] = [];
  for (const address of ['127.0.0.1', '::1']) {
    await new Promise<void>((done) => {
      const server = createHttpServer(() => {});
      server.on('error', () => done());
      server.listen(port, address, () => {
        held.push(server);
        done();
      });
    });
  }
  expect(held.length, `nothing could be bound on port ${port}`).toBeGreaterThan(0);
  return async () => {
    await Promise.all(held.map((server) => new Promise<void>((closed) => server.close(() => closed()))));
  };
}

export function authorizationUrl(text: string): URL {
  const raw = text.split(/\s+/).find((w) => w.startsWith('https://'));
  expect(raw, `no authorization URL in:\n${text}`).toBeDefined();
  return new URL(raw as string);
}

// What the user's browser does after approving, verbatim: a GET on the redirect_uri the
// authorization URL itself names.
export function redirect(url: URL, params: Record<string, string>): Promise<Response> {
  const target = new URL(url.searchParams.get('redirect_uri') as string);
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return fetch(target);
}

export async function hitCallback(port: number, query: string): Promise<void> {
  await fetch(`http://localhost:${port}/callback${query}`);
}

// A raw HTTP/1.1 request written to the socket verbatim — no client library in between. fetch()
// normalizes its target and its query before either reaches the wire, so it can express neither an
// unparseable request target nor a percent-encoded NUL that survives to the handler; both defects
// that reached this listener came in through a socket no test was holding.
//
// A peer that closes cleanly without answering resolves with an empty status line — what a crashed
// handler looks like from here. A peer that ABORTS rejects instead (measured: `read ECONNRESET`);
// the promise settles either way, which is what the caller needs.
const rawSockets: Socket[] = [];

export interface RawAnswer {
  statusLine: string;
  body: string;
}

export function rawExchange(port: number, target: string): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`);
    });
    rawSockets.push(socket);
    let received = '';
    socket.on('data', (chunk) => {
      received += String(chunk);
    });
    socket.on('close', () => resolve(splitAnswer(received)));
    socket.on('error', reject);
  });
}

export function rawRequest(port: number, target: string): Promise<string> {
  return rawExchange(port, target).then((answer) => answer.statusLine);
}

// node sends these short bodies chunked — it has no Content-Length for an end(string) — so the
// bytes after the blank line are "e\r\nState mismatch\r\n0\r\n\r\n", not the body. Whatever a
// FOREIGN listener frames them as, this must return a string rather than throw: it runs on the
// path whose whole job is to report that the peer was not ours.
function splitAnswer(received: string): RawAnswer {
  const [head, ...rest] = received.split('\r\n\r\n');
  const statusLine = head.split('\r\n')[0];
  const raw = rest.join('\r\n\r\n');
  if (!/^transfer-encoding:\s*chunked$/im.test(head)) return { statusLine, body: raw };
  let body = '';
  let remaining = raw;
  for (;;) {
    const eol = remaining.indexOf('\r\n');
    if (eol < 0) return { statusLine, body };
    const size = Number.parseInt(remaining.slice(0, eol), 16);
    // The 0-length terminator, and equally a size this peer did not write as hex (NaN).
    if (!Number.isFinite(size) || size <= 0) return { statusLine, body };
    body += remaining.slice(eol + 2, eol + 2 + size);
    remaining = remaining.slice(eol + 2 + size + 2);
  }
}

// Everything src/auth/oauth-flow.ts can answer on /callback, verbatim: 400 with one of these bodies
// (or "Authorization failed: <code>"), or 200 with that last one. Never 404 — that is the answer it
// gives on a path that is NOT /callback, and a 404 here is the fingerprint #13 was spotted by.
const OUR_BODIES = ['State mismatch', 'Bad request target', 'Missing code', 'Authorized. You can close this tab.'];

// Every caller below asks about /callback, where a 404 is by definition not ours — so there is no
// branch for the unknown-path 404 our listener gives on other paths. A future caller that passes
// one would be told "FOREIGN", loudly and visibly, and then this grows a line.
function couldBeOurs({ statusLine, body }: RawAnswer): boolean {
  if (statusLine.startsWith('HTTP/1.1 400')) {
    return OUR_BODIES.includes(body) || body.startsWith('Authorization failed: ');
  }
  return statusLine.startsWith('HTTP/1.1 200') && body === 'Authorized. You can close this tab.';
}

// The answer to a raw request, having first established that OUR listener is the one that gave it
// (#13, AC5). Without this, a port collision reads as "expected 400, got 404" and sends the reader
// hunting a status bug in code that never ran — that is how #13 was nearly mis-filed. The reverse
// mis-diagnosis is guarded too: a peer that answered nothing at all is OUR handler having died, and
// blaming a stranger for it would be the same error pointed the other way.
export async function answerFromOurListener(port: number, target: string): Promise<RawAnswer> {
  const answer = await settlesWithin(`the raw request ${target}`, rawExchange(port, target));
  if (couldBeOurs(answer)) return answer;
  if (answer.statusLine === '') {
    return expect.fail(
      `the peer on port ${port} closed the connection without answering ${target} — no status line at ` +
        `all. That is OUR listener with a handler that died, not a stranger: read the request handler ` +
        `in src/auth/oauth-flow.ts.`,
    );
  }
  return expect.fail(
    `the answer on port ${port} did not come from our callback listener — a FOREIGN listener holds ` +
      `this port. It answered ${JSON.stringify(answer.statusLine)} with body ${JSON.stringify(answer.body)}; ` +
      `ours answers ${target} with 400 or 200 and one of ${JSON.stringify(OUR_BODIES)}, and never with ` +
      `404. Read this as a port collision (#13), not as a wrong status from our own code.`,
  );
}

// Every socket rawRequest opened, whether or not it was answered. A case whose request hung would
// otherwise leave a handle behind for the suites that follow it.
export function closeRawSockets(): void {
  for (const s of rawSockets.splice(0)) s.destroy();
}

// Proof that nothing is left listening: the port binds again.
export async function rebind(port: number): Promise<void> {
  const probe = createHttpServer(() => {});
  await new Promise<void>((r) => probe.listen(port, r));
  await new Promise((r) => probe.close(r));
}

// Fails loudly instead of hanging until the suite timeout: a promise that never settles IS the
// defect these suites are about — startCallbackListener() feeds beginFlow(), and beginFlow() feeds
// a login queue that holds every later zendesk_login behind it. The label says which call hung.
// Lived as three word-identical copies across the login suites before it landed here.
export function settlesWithin<T>(label: string, promise: Promise<T>, ms = 2_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} never settled within ${ms}ms`)), ms);
      t.unref?.();
    }),
  ]);
}

export function setupLoginHarness(prefix: string): void {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), prefix));
    tokensPath = join(dataDir, 'tokens.enc');
  });
  afterEach(() => {
    // Flow state is module-level: it must not leak into the next case, nor leave a listener bound.
    abortLoginFlow();
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
}
