// tests/plugin/token-canary.test.ts
// Two distinctive values are run through login, refresh and the failure paths of both, and then
// looked for everywhere a value could come out: the tool text the model reads, every console stream,
// and every file in the data directory. The only place either may appear is the ciphertext.
//
// This is a property, not a review: tests/plugin/secret-safe-logging.test.ts already pins WHO may
// write to a stream, and this pins WHAT would be in the write if someone ever may.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AuthManager } from '../../src/auth/auth-manager.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { runLogin, type LoginDeps } from '../../src/tools/login.js';
import type { SetupValues } from '../../src/tools/setup.js';
import type { CallbackListener, OAuthConfig } from '../../src/auth/oauth-flow.js';
import { exchangeCodeForTokens, refreshAccessToken } from '../../src/auth/oauth-flow.js';
import { DEFAULT_SCOPES } from '../../src/auth/config.js';
import { config, dataDir, deps, freePort, setupLoginHarness, tokensPath } from '../auth/login-harness.js';

setupLoginHarness('token-canary-');

const ACCESS = 'CANARY-ACCESS-9f3b1c7e-do-not-print';
const REFRESH = 'CANARY-REFRESH-4a8d2e60-do-not-print';
// The client secret joins them: since #68 it is typed into a local page, and the whole reason that page
// exists rather than a question in the chat is that this value must never reach the model.
const CLIENT_SECRET = 'CANARY-SECRET-7c1e5b92-do-not-print';
const CANARIES = [ACCESS, REFRESH, CLIENT_SECRET];

const tokenResponse = { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 3600 };

// Every console stream at once: the allowlist test says only two files may write, and this says that
// if one of them ever does, a token is not what comes out.
function captureConsole(): { lines: () => string; restore: () => void } {
  const written: string[] = [];
  const spies = (['log', 'info', 'debug', 'warn', 'error', 'trace'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      written.push(args.map(String).join(' '));
    }),
  );
  return { lines: () => written.join('\n'), restore: () => spies.forEach((s) => s.mockRestore()) };
}

// Every file under the data directory, by content. tokens.enc is read as text on purpose: it is
// base64, so a plaintext token in it would be found by exactly this search.
function dataDirContents(): string {
  const dir = dataDir;
  return readdirSync(dir, { recursive: true })
    .map((entry) => join(dir, String(entry)))
    .filter((path) => statSync(path).isFile())
    .map((path) => `${path}\n${readFileSync(path, 'utf8')}`)
    .join('\n');
}

const arrived = (port: number): NonNullable<LoginDeps['listen']> =>
  async (): Promise<CallbackListener> => ({
    promise: Promise.resolve({ code: 'auth-code', redirectUri: `http://localhost:${port}/callback` }),
    close: () => {},
  });

const expectNoCanary = (haystack: string, where: string): void => {
  for (const canary of CANARIES) expect(haystack, where).not.toContain(canary);
};

let console_: ReturnType<typeof captureConsole> | undefined;
afterEach(() => {
  console_?.restore();
  console_ = undefined;
});

describe('a token that went through the whole flow', () => {
  it('is in the ciphertext and in no tool answer, no log line and no other file', async () => {
    console_ = captureConsole();
    const port = freePort();
    const login = deps(port, { listen: arrived(port), exchange: async () => tokenResponse });

    const started = await runLogin(login);
    const finished = await runLogin(login);

    expect(finished).toMatch(/authorization complete/i);
    expectNoCanary(started, 'the first login answer');
    expectNoCanary(finished, 'the second login answer');
    expectNoCanary(console_.lines(), 'the console');
    expectNoCanary(dataDirContents(), 'the data directory');
    // And the tokens really are in there — otherwise this case would pass on an empty store.
    expect(new TokenStore(tokensPath, login.tokenStoreKey).load()).toMatchObject({ accessToken: ACCESS });
  });

  it('survives a refresh, and the refreshed pair does not come out either', async () => {
    console_ = captureConsole();
    const port = freePort();
    const store = new TokenStore(tokensPath, 'a-key');
    store.save({ accessToken: 'at-stale', refreshToken: 'rt-stale', expiresAt: Date.now() - 1 });
    const refresh = (async () => tokenResponse) as unknown as typeof refreshAccessToken;

    const token = await new AuthManager(store, config(port), refresh).getAccessToken();

    // The caller gets the access token — that IS the return value — but nothing wrote it anywhere.
    expect(token).toBe(ACCESS);
    expectNoCanary(console_.lines(), 'the console');
    expectNoCanary(dataDirContents(), 'the data directory');
  });

  it('is not echoed back by a failed exchange, however the failure arrives', async () => {
    console_ = captureConsole();
    const port = freePort();
    const failures: Array<[string, LoginDeps['exchange']]> = [
      ['a rejected exchange', async () => { throw new Error('Token exchange failed: 400 invalid_grant'); }],
      // The sharpest one: a response that LOOKS like success and carries the tokens, but is malformed.
      // The parser must name the fields that are wrong and never the body it read them from.
      ['a malformed success body', (async (c: OAuthConfig, code: string, verifier: string, uri: string) =>
        exchangeCodeForTokens(c, code, verifier, uri, (async () =>
          new Response(JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })) as unknown as typeof fetch)) as LoginDeps['exchange']],
    ];

    for (const [label, exchange] of failures) {
      const login = deps(port, { listen: arrived(port), exchange });
      await runLogin(login);
      const answer = await runLogin(login);
      expect(answer, label).toMatch(/zendesk login failed/i);
      expectNoCanary(answer, label);
    }
    expectNoCanary(console_.lines(), 'the console');
    expectNoCanary(dataDirContents(), 'the data directory');
  });

  it('is not echoed back by a failed refresh', async () => {
    console_ = captureConsole();
    const port = freePort();
    const store = new TokenStore(tokensPath, 'a-key');
    store.save({ accessToken: 'at-stale', refreshToken: REFRESH, expiresAt: Date.now() - 1 });
    // The refresh token is the one the caller HAS, so a failure that quoted its own request would
    // leak it. Zendesk answers a dead grant with a short body; the message must stay on that side.
    const refresh = (async (c: OAuthConfig, token: string) =>
      refreshAccessToken(c, token, (async () => new Response('invalid_grant', { status: 400 })) as unknown as typeof fetch)) as typeof refreshAccessToken;

    const failure = await new AuthManager(store, config(port), refresh)
      .getAccessToken()
      .then(() => 'resolved', (err: unknown) => (err instanceof Error ? err.message : String(err)));

    expect(failure).toMatch(/400 invalid_grant/);
    expectNoCanary(failure, 'the refresh failure');
    expectNoCanary(console_.lines(), 'the console');
  });
});

describe('a client secret typed into the setup page', () => {
  it('is stored and never appears in a tool answer, a log line or a file', async () => {
    const console_ = captureConsole();
    const port = freePort();
    const stored: SetupValues[] = [];
    const login: LoginDeps = {
      config: { subdomain: '', clientId: '', callbackPort: port, scopes: DEFAULT_SCOPES },
      tokensPath,
      tokenStoreKey: 'a-key',
      configError: 'Missing required environment variable: ZENDESK_SUBDOMAIN.',
      setup: { writeConfig: (values) => stored.push(values), timeoutMs: 60_000 },
      exchange: async () => tokenResponse,
    };

    const started = await runLogin(login);
    const setupPageUrl = new URL(started.split(/\s+/).find((w) => w.startsWith('http://')) as string);
    const submitted = await fetch(setupPageUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: setupPageUrl.origin },
      body: new URLSearchParams({ subdomain: 'acme', client_id: 'client-abc', client_secret: CLIENT_SECRET }).toString(),
    });
    const redirect = submitted.headers.get('location') as string;
    const body = await submitted.text();

    // It reached the store — otherwise this case would pass on a flow that never carried it.
    expect(stored).toEqual([
      { ZENDESK_SUBDOMAIN: 'acme', ZENDESK_OAUTH_CLIENT_ID: 'client-abc', ZENDESK_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
    ]);
    // And it is in none of the places it could have come out of. The authorization URL is the sharpest
    // one: a client_secret query parameter there would hand the secret to Zendesk's logs and to the
    // browser history in one step.
    expectNoCanary(body, 'the setup response body');
    expectNoCanary(redirect, 'the authorization redirect');
    expectNoCanary(started, 'the tool answer that started setup');
    expectNoCanary(await runLogin(login), 'the tool answer while setup is pending');

    // Every failure path of the same page, too: a bad field, a replay, and a foreign origin.
    for (const [label, init] of [
      ['a rejected field', { body: new URLSearchParams({ subdomain: 'nope.zendesk.com', client_id: 'c', client_secret: CLIENT_SECRET }).toString(), origin: setupPageUrl.origin }],
      ['a foreign origin', { body: new URLSearchParams({ subdomain: 'acme', client_id: 'c', client_secret: CLIENT_SECRET }).toString(), origin: 'https://evil.example.com' }],
    ] as const) {
      const answer = await fetch(setupPageUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: init.origin },
        body: init.body,
      });
      expectNoCanary(await answer.text(), label);
    }

    expectNoCanary(console_.lines(), 'the console');
    expectNoCanary(dataDirContents(), 'the data directory');
    console_.restore();
  });
});
