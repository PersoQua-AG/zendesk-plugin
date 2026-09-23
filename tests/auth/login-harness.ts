// Shared fixture for the three zendesk_login suites. It held three wordlike-identical copies of
// freePort/config/deps/authorizationUrl and of the beforeEach/afterEach pair; the afterEach in
// particular is load-bearing — runLogin keeps its flow in module state, so a case that leaves a
// listener bound makes the NEXT case depend on the order it ran in.
import { expect, beforeEach, afterEach, vi } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
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
// What this does NOT prevent: a foreign process that deliberately binds a port inside the band.
// Such a port makes the production listener fail its bind with a named EADDRINUSE — loud, and
// nothing like the silent wrong-listener answers this issue is about.
export const PORT_BAND_FIRST = 20_000;
export const PORT_BAND_LAST = 29_999;
const PORT_BAND_SIZE = PORT_BAND_LAST - PORT_BAND_FIRST + 1;

const CLAIM_DIR = join(tmpdir(), 'zendesk-plugin-test-ports');

// The proof that a port is held, as a path a test can read: freePort() returns only once this file
// exists and names the process that owns it.
export function portClaimPath(port: number): string {
  return join(CLAIM_DIR, String(port));
}

// No run of this suite lasts anywhere near this long, so a claim older than it is wreckage even
// when its pid still answers — pids are reused, and a claim held by an unrelated live process would
// otherwise hold its port for the lifetime of the machine. Measured before this ceiling existed:
// `mkdir $T/20001; echo 1 > $T/20001/pid` survived every later load.
const MAX_CLAIM_AGE_MS = 30 * 60_000;

// `kill(pid, 0)` sends no signal, it only asks. EPERM means the process exists and is someone
// else's — alive. ESRCH, an unreadable claim, or content that is not a pid means nobody holds it.
function ownerAlive(path: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Both halves are required: young enough to belong to a running suite, AND owned by a process that
// still exists. Either alone leaks the band — the first to killed runs, the second to reused pids.
function claimIsLive(path: string): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    // Gone between the readdir and the stat: another run swept it, and there is nothing to keep.
    return false;
  }
  return age < MAX_CLAIM_AGE_MS && ownerAlive(path);
}

// Vitest ends its worker processes with a signal, so 'exit' hooks do not run and nothing releases a
// claim at the end of a case. Reclamation is therefore the ONLY release: every process sweeps what
// dead ones left before it takes anything. Measured without it: 779 claims after seven runs, and a
// band exhausted after roughly ninety.
function sweepDeadClaims(): void {
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
      // Every entry here carries its owner's pid — a claim and a staging file alike — so one rule
      // covers both. `recursive` also clears a claim left by the mkdir shape this replaced.
      if (!claimIsLive(path)) rmSync(path, { recursive: true, force: true });
    } catch {
      // A concurrent run swept the same entry first. Not ours to report.
    }
  }
}

mkdirSync(CLAIM_DIR, { recursive: true });
sweepDeadClaims();

// A claim must NEVER be observable without its owner: a claim that can be read empty is a claim a
// concurrent sweep calls ownerless and removes, and then the port goes out twice — the very defect
// this replaces, in a narrower window. So the pid is written under a private staging name FIRST and
// the finished file is then hard-linked into place; link() fails with EEXIST when the name is
// taken, which makes publication and test-and-set one step. (Create-then-write, mkdir-then-write
// included, cannot do that: measured, `printf "" > $T/20002/pid` was swept despite a fresh mtime.)
// Each claim gets its own staging file, and so its own inode: hard links share an mtime, and a
// reused staging file would keep refreshing the age of every claim already linked from it.
let stagingSeq = 0;

function tryClaim(port: number): boolean {
  const staging = join(CLAIM_DIR, `.staging-${process.pid}-${(stagingSeq += 1)}`);
  writeFileSync(staging, String(process.pid));
  try {
    linkSync(staging, portClaimPath(port));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    rmSync(staging, { force: true });
  }
}

function claimError(port: number, err: unknown): Error {
  return new Error(`could not claim test port ${port} at ${portClaimPath(port)}: ${(err as Error).message}`);
}

// Only EEXIST means "taken". Anything else is reported with the path rather than read as taken,
// which would spin the scan below through all 10 000 candidates and then blame exhaustion.
function claimPort(port: number): boolean {
  try {
    return tryClaim(port);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw claimError(port, err);
    // macOS prunes its per-user temp dir, and in this session it did — every later freePort() threw
    // ENOENT with no way back. Rebuild the directory and try once; a second failure is real.
    try {
      mkdirSync(CLAIM_DIR, { recursive: true });
      return tryClaim(port);
    } catch (retry) {
      throw claimError(port, retry);
    }
  }
}

// Where this process starts scanning. Only an optimization — the claims, not the offset, are what
// make two acquirers disagree — so that concurrent runs do not walk the same prefix every time.
let nextCandidate = process.pid % PORT_BAND_SIZE;

export function freePort(): number {
  for (let tried = 0; tried < PORT_BAND_SIZE; tried += 1) {
    const port = PORT_BAND_FIRST + (nextCandidate % PORT_BAND_SIZE);
    nextCandidate += 1;
    if (claimPort(port)) return port;
  }
  throw new Error(
    `no unclaimed port left in ${PORT_BAND_FIRST}-${PORT_BAND_LAST}; stale claims under ${CLAIM_DIR}?`,
  );
}

export function config(port: number): OAuthConfig {
  return { subdomain: 'acme', clientId: 'client-abc', clientSecret: SECRET, callbackPort: port, scopes: ['read', 'write'] };
}

export function deps(port: number, overrides: Partial<LoginDeps> = {}): LoginDeps {
  return { config: config(port), tokensPath, ...overrides };
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

// Everything src/auth/oauth-flow.ts can answer, verbatim. On /callback: 400 with one of these
// bodies (or "Authorization failed: <code>"), or 200 with that last one. On any OTHER path: 404 with
// no body at all (src/auth/oauth-flow.ts, the pathname guard). The asymmetry is the fingerprint —
// our listener never answers /callback with 404, which is how #13 was spotted.
const OUR_BODIES = ['State mismatch', 'Bad request target', 'Missing code', 'Authorized. You can close this tab.'];

function requestPath(target: string): string {
  return target.split('?')[0];
}

function couldBeOurs(target: string, { statusLine, body }: RawAnswer): boolean {
  if (statusLine.startsWith('HTTP/1.1 400')) {
    return OUR_BODIES.includes(body) || body.startsWith('Authorization failed: ');
  }
  if (statusLine.startsWith('HTTP/1.1 200')) return body === 'Authorized. You can close this tab.';
  // Our own 404 — the unknown-path answer, and OURS on any path but /callback.
  return statusLine.startsWith('HTTP/1.1 404') && body === '' && requestPath(target) !== '/callback';
}

// The answer to a raw request, having first established that OUR listener is the one that gave it
// (#13, AC5). Without this, a port collision reads as "expected 400, got 404" and sends the reader
// hunting a status bug in code that never ran — that is how #13 was nearly mis-filed. The reverse
// mis-diagnosis is guarded too: a peer that answered nothing at all is OUR handler having died, and
// blaming a stranger for it would be the same error pointed the other way.
export async function answerFromOurListener(port: number, target: string): Promise<RawAnswer> {
  const answer = await settlesWithin(`the raw request ${target}`, rawExchange(port, target));
  if (couldBeOurs(target, answer)) return answer;
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
      `ours answers ${target} with 400 or 200 and one of ${JSON.stringify(OUR_BODIES)}, and 404 only on a ` +
      `path that is not /callback. Read this as a port collision (#13), not as a wrong status from our ` +
      `own code.`,
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
