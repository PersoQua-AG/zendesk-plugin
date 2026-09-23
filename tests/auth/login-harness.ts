// Shared fixture for the three zendesk_login suites. It held three wordlike-identical copies of
// freePort/config/deps/authorizationUrl and of the beforeEach/afterEach pair; the afterEach in
// particular is load-bearing — runLogin keeps its flow in module state, so a case that leaves a
// listener bound makes the NEXT case depend on the order it ran in.
import { expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
//   2. claiming it with mkdir, which is the atomic test-and-set every platform agrees on, in a
//      directory under the system temp dir. The claim is machine-wide because the collision was:
//      vitest runs each test file in its own process, and a second checkout runs its own vitest.
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

// The proof that a port is held, as a path a test can stat: `freePort` returns only after this
// directory exists, and it is removed at process exit, not at the end of the case.
export function portClaimPath(port: number): string {
  return join(CLAIM_DIR, String(port));
}

// Who holds a claim, so the next run can tell a live reservation from the wreckage of a killed one.
// Measured, and the reason the exit hook below is not enough on its own: after seven runs the claim
// dir held 779 entries — vitest ends its worker processes with a signal, and 'exit' does not run
// then. Without reclamation the band is exhausted after roughly ninety runs.
const OWNER_FILE = 'pid';

// The only window in which a claim has no owner file is between the mkdir and the write a few
// microseconds later. A minute of grace closes it: a sweep must never take a claim a live process
// is in the middle of making — that would hand the same port out twice, which is the very defect
// this replaces.
const OWNERLESS_GRACE_MS = 60_000;

const heldClaims: string[] = [];

// `kill(pid, 0)` sends no signal, it only asks. EPERM means the process exists and is someone
// else's — alive. ESRCH, and anything unreadable, means there is nobody to hold this claim.
function claimIsLive(path: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(join(path, OWNER_FILE), 'utf8'), 10);
  } catch {
    try {
      return statSync(path).mtimeMs >= Date.now() - OWNERLESS_GRACE_MS;
    } catch {
      return false;
    }
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sweepDeadClaims(): void {
  let entries: string[];
  try {
    entries = readdirSync(CLAIM_DIR);
  } catch {
    // No claim dir yet, or it is unreadable: nothing to sweep, and freePort's own mkdir reports the
    // unreadable case with the path in the message.
    return;
  }
  for (const entry of entries) {
    const path = join(CLAIM_DIR, entry);
    try {
      if (!claimIsLive(path)) rmSync(path, { recursive: true, force: true });
    } catch {
      // A concurrent run swept the same entry first. Not ours to report.
    }
  }
}

mkdirSync(CLAIM_DIR, { recursive: true });
sweepDeadClaims();
process.on('exit', () => {
  for (const path of heldClaims.splice(0)) rmSync(path, { recursive: true, force: true });
});

// mkdir with no `recursive` fails with EEXIST when the name is taken — atomically, across processes.
// Every other failure (an unwritable temp dir, say) is reported rather than read as "taken", which
// would spin the scan below through all 10 000 candidates and then blame exhaustion.
function claimPort(port: number): boolean {
  const path = portClaimPath(port);
  try {
    mkdirSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw new Error(`could not claim test port ${port} at ${path}: ${(err as Error).message}`);
  }
  // Immediately after the mkdir, so the window in which this claim looks ownerless is as short as
  // a write. A failure here leaves a claim nobody can attribute; it is swept a minute later, and
  // the throw reaches the test rather than being read as "port taken".
  writeFileSync(join(path, OWNER_FILE), String(process.pid));
  heldClaims.push(path);
  return true;
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
// that reached this listener came in through a socket no test was holding. Resolves with the status
// line, or '' if the peer hung up without answering (what a crashed handler looks like from here).
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

// Everything src/auth/oauth-flow.ts can answer on a /callback target, verbatim: 400 with one of
// these bodies, 200 with that one. It answers 404 ONLY on a path that is not /callback.
const OUR_BODIES = ['State mismatch', 'Bad request target', 'Missing code', 'Authorized. You can close this tab.'];

function couldBeOurs({ statusLine, body }: RawAnswer): boolean {
  return (
    (statusLine.startsWith('HTTP/1.1 400') && (OUR_BODIES.includes(body) || body.startsWith('Authorization failed: '))) ||
    (statusLine.startsWith('HTTP/1.1 200') && OUR_BODIES.includes(body))
  );
}

// The answer to a /callback request, having first established that OUR listener is the one that
// gave it (#13, AC5). Without this, a port collision reads as "expected 400, got 404" and sends the
// reader hunting a status bug in code that never ran — that is how #13 was nearly mis-filed.
export async function answerFromOurListener(port: number, target: string): Promise<RawAnswer> {
  const answer = await settlesWithin(`the raw request ${target}`, rawExchange(port, target));
  if (couldBeOurs(answer)) return answer;
  return expect.fail(
    `the answer on port ${port} did not come from our callback listener — a FOREIGN listener holds ` +
      `this port. It answered ${JSON.stringify(answer.statusLine)} with body ${JSON.stringify(answer.body)}; ` +
      `ours answers ${target} with 400 or 200 and one of ${JSON.stringify(OUR_BODIES)}. Read this as a port ` +
      `collision (#13), not as a wrong status from our own code.`,
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
