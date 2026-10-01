import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { runLogin, type LoginDeps } from '../../src/tools/login.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { DEFAULT_SCOPES } from '../../src/auth/config.js';
import type { SetupValues } from '../../src/tools/setup.js';
import { SECRET, dataDir, freePort, setupLoginHarness, tokensPath } from './login-harness.js';

setupLoginHarness('setup-flow-');

// The whole first run, through the real listener: the tool answers with a local page, the page stores
// the three values and redirects into the Zendesk authorization, the callback lands on that SAME
// listener, and the second tool call exchanges the code. One port, one flow, one lock.

const CONFIGURED = {
  ZENDESK_SUBDOMAIN: 'acme',
  ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
  ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
};

// The shape src/server.ts builds when it could not resolve a configuration but CAN store one: an empty
// client, the port the page will name, the scopes the authorization will ask for, and the degraded
// wording as the fallback for a bind that fails.
function unconfiguredDeps(port: number, writeConfig: (values: SetupValues) => void): LoginDeps {
  return {
    config: { subdomain: '', clientId: '', callbackPort: port, scopes: DEFAULT_SCOPES },
    tokensPath,
    tokenStoreKey: SECRET,
    configError: 'Missing required environment variable: ZENDESK_SUBDOMAIN (extension configuration field "zendesk_subdomain" is empty).',
    setup: { writeConfig, timeoutMs: 60_000 },
  };
}

const urlIn = (text: string, scheme = 'http://'): URL =>
  new URL(text.split(/\s+/).find((word) => word.startsWith(scheme)) as string);

const page = (url: URL, init?: RequestInit): Promise<Response> =>
  fetch(url, { redirect: 'manual', ...init });

function formPost(url: URL, values: Record<string, string>): Promise<Response> {
  return page(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: url.origin },
    body: new URLSearchParams(values).toString(),
  });
}

const GOOD_FORM = { subdomain: 'acme', client_id: 'client-abc', client_secret: 'secret-xyz' };

describe('the first run, end to end', () => {
  it('answers with a setup page, stores the three values, and walks into the authorization', async () => {
    const port = freePort();
    const stored: SetupValues[] = [];
    const deps = unconfiguredDeps(port, (values) => stored.push(values));

    // Call 1: the page, and nothing else. No field name, no path, no value.
    const first = await runLogin(deps);
    expect(first).toMatch(/not set up/i);
    const setupPageUrl = urlIn(first);
    expect(setupPageUrl.pathname).toBe('/setup');
    expect(first).not.toContain('zendesk_subdomain');
    expect(first.match(/https?:\/\//g)).toHaveLength(1);

    // The page itself, then the form.
    expect((await page(setupPageUrl)).status).toBe(200);
    const submitted = await formPost(setupPageUrl, GOOD_FORM);

    expect(submitted.status).toBe(303);
    expect(stored).toEqual([CONFIGURED]);

    // It redirects into the Zendesk authorization, built from what was just entered — with PKCE, and
    // with the redirect_uri that points back at this very listener.
    const authorize = new URL(submitted.headers.get('location') as string);
    expect(authorize.origin).toBe('https://acme.zendesk.com');
    expect(authorize.searchParams.get('client_id')).toBe('client-abc');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('scope')).toBe('read write');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`http://localhost:${port}/callback`);

    // What the browser does next, verbatim: Zendesk sends it to the redirect_uri with the code and the
    // state the authorization URL carried.
    const state = authorize.searchParams.get('state') as string;
    await fetch(`http://localhost:${port}/callback?state=${state}&code=code-after-setup`);

    // Call 2 exchanges that code against the configuration the PAGE supplied — the deps this process
    // holds still carry the empty one.
    let exchangedWith: { subdomain: string; clientSecret?: string; code: string } | undefined;
    const finished = await runLogin({
      ...deps,
      exchange: async (config, code) => {
        exchangedWith = { subdomain: config.subdomain, clientSecret: config.clientSecret, code };
        return { accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 3600 };
      },
    });

    expect(exchangedWith).toEqual({ subdomain: 'acme', clientSecret: 'secret-xyz', code: 'code-after-setup' });
    expect(finished).toMatch(/authorization complete/i);
    // The one thing this path has to say beyond the usual: this session resolved its configuration
    // before any of it existed, so it has to be reloaded.
    expect(finished).toMatch(/reload the plugin/i);
    expect(new TokenStore(tokensPath, SECRET).load()).toMatchObject({ accessToken: 'at-1' });
  });

  it('repeats the page while it has not been submitted, and starts no second listener', async () => {
    const port = freePort();
    const deps = unconfiguredDeps(port, () => {});

    const first = await runLogin(deps);
    const second = await runLogin(deps);

    expect(second).toMatch(/still open/i);
    expect(urlIn(second).href).toBe(urlIn(first).href);
    // One listener on the port, so the page the first answer named is the page the second one names.
    expect((await page(urlIn(second))).status).toBe(200);
  });

  it('reaches setup again with force, on the same lock, with a fresh token', async () => {
    const port = freePort();
    const deps = unconfiguredDeps(port, () => {});

    const first = urlIn(await runLogin(deps));
    const again = urlIn(await runLogin(deps, { force: true }));

    expect(again.searchParams.get('t')).not.toBe(first.searchParams.get('t'));
    // The old page is gone with the flow it belonged to — its listener was closed and the new one
    // holds the port.
    expect((await page(first)).status).toBe(404);
    expect((await page(again)).status).toBe(200);
  });

  it('answers with the degraded wording, not a page, when the port cannot be bound', async () => {
    const port = freePort();
    const deps = unconfiguredDeps(port, () => {});
    const failing: LoginDeps['listen'] = () => Promise.reject(new Error('listen EADDRINUSE: address already in use'));

    const answer = await runLogin({ ...deps, listen: failing });

    expect(answer).toBe(deps.configError);
    expect(answer).not.toContain('/setup');
  });

  it('stores nothing and keeps the flow when the values cannot be written', async () => {
    const port = freePort();
    const deps = unconfiguredDeps(port, () => {
      throw new Error('keychain write refused');
    });

    const setupPageUrl = urlIn(await runLogin(deps));
    const refused = await formPost(setupPageUrl, GOOD_FORM);

    expect(refused.status).toBe(500);
    expect(existsSync(tokensPath)).toBe(false);
    // The flow is still the one that was started, so the person can try again on the same page.
    expect(await runLogin(deps)).toMatch(/still open/i);
  });

  it('offers no page at all when there is nowhere to store the answer', async () => {
    const port = freePort();
    const { setup: _dropped, ...noSetup } = unconfiguredDeps(port, () => {});

    const answer = await runLogin(noSetup);

    expect(answer).toBe(noSetup.configError);
    expect(answer).toContain('zendesk_subdomain');
  });

  it('leaves a configured install alone: no page, the ordinary login', async () => {
    const port = freePort();
    const configured: LoginDeps = {
      config: { subdomain: 'acme', clientId: 'client-abc', clientSecret: 'secret-xyz', callbackPort: port, scopes: DEFAULT_SCOPES },
      tokensPath,
      tokenStoreKey: SECRET,
      callbackTimeoutMs: 60_000,
      setup: { writeConfig: () => expect.fail('a configured install must never run setup') },
    };

    const answer = await runLogin(configured);

    expect(answer).toMatch(/authorization started/i);
    expect(urlIn(answer, 'https://').origin).toBe('https://acme.zendesk.com');
    expect(answer).not.toContain('/setup');
    expect(dataDir).toBeTruthy();
  });
});
