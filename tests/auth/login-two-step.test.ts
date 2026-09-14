import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { runLogin, abortLoginFlow, type LoginDeps } from '../../src/tools/login.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { generateCodeChallenge } from '../../src/auth/pkce.js';
import type { OAuthConfig } from '../../src/auth/oauth-flow.js';

// The two-call login, walked over the REAL localhost listener — no listener stub anywhere in this
// file. This is the level at which the previous design failed while its suite stayed green: the
// tests stubbed the wait, so nobody noticed that a human could never reach the happy path (the URL
// arrived only after the call had finished waiting, and the retry re-rolled the `state` that the
// already-published URL carried). Only the token exchange is stubbed, so no test touches Zendesk.

const SECRET = 'secret-xyz';

let dataDir: string;
let tokensPath: string;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createHttpServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function config(port: number): OAuthConfig {
  return { subdomain: 'acme', clientId: 'client-abc', clientSecret: SECRET, callbackPort: port, scopes: ['read', 'write'] };
}

function deps(port: number, overrides: Partial<LoginDeps> = {}): LoginDeps {
  return { config: config(port), tokensPath, ...overrides };
}

function authorizationUrl(text: string): URL {
  const raw = text.split(/\s+/).find((w) => w.startsWith('https://'));
  expect(raw, `no authorization URL in:\n${text}`).toBeDefined();
  return new URL(raw as string);
}

// What the user's browser does after approving, verbatim: a GET on the redirect_uri the
// authorization URL itself names.
function redirect(url: URL, params: Record<string, string>): Promise<Response> {
  const target = new URL(url.searchParams.get('redirect_uri') as string);
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return fetch(target);
}

async function rebind(port: number): Promise<void> {
  const probe = createHttpServer(() => {});
  await new Promise<void>((r) => probe.listen(port, r));
  await new Promise((r) => probe.close(r));
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'login-two-step-'));
  tokensPath = join(dataDir, 'tokens.enc');
});
afterEach(() => {
  abortLoginFlow();
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('the two-call login over the real callback listener', () => {
  it('call 1 hands out the URL, the browser redirect lands, call 2 completes the login', async () => {
    const port = await freePort();
    let exchanged: { code: string; verifier: string; redirectUri: string } | null = null;
    const d = deps(port, {
      exchange: async (_cfg, code, verifier, redirectUri) => {
        exchanged = { code, verifier, redirectUri };
        return { accessToken: 'access-e2e', refreshToken: 'refresh-e2e', expiresIn: 3600 };
      },
    });

    const first = await runLogin(d);
    const url = authorizationUrl(first);
    expect(existsSync(tokensPath)).toBe(false);

    const response = await redirect(url, { state: url.searchParams.get('state') as string, code: 'browser-code' });
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/close this tab/i);

    const second = await runLogin(d);
    expect(second).toMatch(/authorization complete/i);
    expect(new TokenStore(tokensPath, SECRET).load()).toMatchObject({ accessToken: 'access-e2e' });

    // The code came from the real listener, and the PKCE verifier used on call 2 is the one whose
    // challenge went out in call 1's URL — proof that the flow, not the call, owns the secret.
    expect(exchanged).toMatchObject({ code: 'browser-code', redirectUri: `http://localhost:${port}/callback` });
    expect(generateCodeChallenge((exchanged as unknown as { verifier: string }).verifier)).toBe(url.searchParams.get('code_challenge'));

    // Nothing is left listening once the flow is collected.
    await rebind(port);
  });

  it('keeps the same state across calls, so the URL handed out first still works', async () => {
    const port = await freePort();
    const d = deps(port, {
      callbackTimeoutMs: 60_000,
      exchange: async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }),
    });
    const first = authorizationUrl(await runLogin(d));
    const second = authorizationUrl(await runLogin(d));
    const state = first.searchParams.get('state') as string;

    expect(state).toBeTruthy();
    expect(second.searchParams.get('state')).toBe(state);
    expect(second.searchParams.get('code_challenge')).toBe(first.searchParams.get('code_challenge'));

    // And the listener still accepts exactly that state.
    expect((await redirect(first, { state, code: 'c' })).status).toBe(200);
    expect(await runLogin(d)).toMatch(/authorization complete/i);
  });

  it('rejects a callback that carries a foreign state and stores nothing', async () => {
    const port = await freePort();
    const d = deps(port, { callbackTimeoutMs: 60_000 });
    const url = authorizationUrl(await runLogin(d));

    const response = await redirect(url, { state: 'not-the-flow-state', code: 'c' });
    expect(response.status).toBe(400);

    const text = await runLogin(d);
    expect(text).toMatch(/state mismatch/i);
    expect(existsSync(tokensPath)).toBe(false);
  });

  it('answers a call made before the callback arrived with a wait notice, not a new flow', async () => {
    const port = await freePort();
    const d = deps(port, { callbackTimeoutMs: 60_000 });
    const first = await runLogin(d);
    const second = await runLogin(d);
    expect(second).toMatch(/still waiting/i);
    expect(second).toContain(String(port));
    expect(authorizationUrl(second).toString()).toBe(authorizationUrl(first).toString());
    expect(existsSync(tokensPath)).toBe(false);
  });
});

describe('a flow that ends without a callback', () => {
  it('times out, cleans up, and the next login starts over with a NEW state', async () => {
    const port = await freePort();
    const d = deps(port, { callbackTimeoutMs: 30 });
    const stale = authorizationUrl(await runLogin(d));
    await new Promise((r) => setTimeout(r, 80));

    // The listener is already gone when the timeout fires, before anyone collects it.
    await rebind(port);

    const collected = await runLogin(d);
    expect(collected).toMatch(/timed out/i);
    expect(collected).toContain('start a new authorization');

    const fresh = authorizationUrl(await runLogin(d));
    expect(fresh.searchParams.get('state')).not.toBe(stale.searchParams.get('state'));
    expect(fresh.searchParams.get('code_challenge')).not.toBe(stale.searchParams.get('code_challenge'));
  });

  it('force abandons the flow in progress and starts a new one on the same port', async () => {
    const port = await freePort();
    const d = deps(port, { callbackTimeoutMs: 60_000 });
    const stale = authorizationUrl(await runLogin(d));

    const restarted = await runLogin(d, { force: true });
    const fresh = authorizationUrl(restarted);
    expect(restarted).not.toMatch(/still waiting/i);
    expect(fresh.searchParams.get('state')).not.toBe(stale.searchParams.get('state'));

    // The abandoned state is dead; only the new one is accepted.
    expect((await redirect(stale, { state: stale.searchParams.get('state') as string, code: 'c' })).status).toBe(400);
    expect(await runLogin(d)).toMatch(/state mismatch/i);
  });

  it('leaves no handle that could keep the process alive', async () => {
    const port = await freePort();
    const realSetTimeout = globalThis.setTimeout;
    const timers: NodeJS.Timeout[] = [];
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const timer = realSetTimeout(fn, ms);
      timers.push(timer);
      return timer;
    }) as unknown as typeof setTimeout);

    const baseline = process.getActiveResourcesInfo().length;
    const d = deps(port, {
      callbackTimeoutMs: 60_000,
      exchange: async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }),
    });
    const url = authorizationUrl(await runLogin(d));
    spy.mockRestore();

    // The flow owns exactly one timer, and it is unref'd: a minute-long authorization window must
    // never be the reason the host process refuses to exit.
    expect(timers).toHaveLength(1);
    expect(timers[0].hasRef()).toBe(false);

    await redirect(url, { state: url.searchParams.get('state') as string, code: 'c' });
    await runLogin(d);

    expect(timers[0].hasRef()).toBe(false);
    // And the completed flow added nothing to what keeps the event loop alive.
    expect(process.getActiveResourcesInfo().length).toBeLessThanOrEqual(baseline);
    await rebind(port);
  });
});

// REGRESSION (qa-engineer, 2026-09-14). Until c21c786 a synchronous `loginInFlight` marker was set
// BEFORE the flow did any awaiting, and login-url-visibility.test.ts pinned the consequence: "the
// second call does not blame the user for the port the FIRST login occupies". The two-call rewrite
// replaced that marker with `activeFlow`, which is assigned only AFTER `await listener.ready`
// (src/tools/login.ts:154-160). That reopens the window the marker existed to close, and the
// deleted assertion no longer guards it.
//
// The window is reachable in practice precisely because the tool now asks to be called twice: a
// model that emits both tool_use blocks in one turn produces exactly this interleaving. The second
// call then binds a rival listener on the same port, gets EADDRINUSE from the FIRST call's
// listener, and tells the user to close whatever is listening or to change oauth_callback_port and
// restart the extension — advice that would destroy the very flow that is working.
describe('two zendesk_login calls that overlap', () => {
  it('does not blame the user for the port the other call is holding', async () => {
    const port = await freePort();
    const d = deps(port, { callbackTimeoutMs: 60_000 });

    const [a, b] = await Promise.all([runLogin(d), runLogin(d)]);
    // Exactly one call starts the flow; the other must recognise it, not compete with it.
    const [started, other] = /authorization started/i.test(a) ? [a, b] : [b, a];
    expect(started, `neither call started a flow:\n${a}\n---\n${b}`).toMatch(/authorization started/i);

    expect(other, `the overlapping call blamed the port:\n${other}`).not.toContain('Close whatever is listening');
    expect(other).not.toContain('oauth_callback_port');
    expect(other).not.toMatch(/restart the extension/i);

    // Whatever it says, it must leave the user on the one live flow: either by naming its URL again
    // or by pointing at the authorization already in progress.
    const live = authorizationUrl(started).searchParams.get('state') as string;
    expect(other, `the overlapping call stranded the user:\n${other}`).toMatch(/still waiting|already waiting|authorization started/i);
    if (/https:\/\//.test(other)) {
      expect(authorizationUrl(other).searchParams.get('state')).toBe(live);
    }

    // And only one listener exists: the live flow's state is the one the port accepts.
    expect((await redirect(authorizationUrl(started), { state: live, code: 'c' })).status).toBe(200);
  });
});
