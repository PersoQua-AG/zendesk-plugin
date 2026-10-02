import { describe, it, expect } from 'vitest';
import { AuthManager } from '../../src/auth/auth-manager.js';
import { runLogin, type LoginDeps } from '../../src/tools/login.js';
import type { CallbackListener } from '../../src/auth/oauth-flow.js';
import { TokenStore, type StoredTokens } from '../../src/auth/token-store.js';
import { writeFileSync } from 'node:fs';
import { authorizationUrl, config, deps, freePort, setupLoginHarness } from './login-harness.js';

setupLoginHarness('auto-login-');

// The first tool call without usable credentials is the moment the user finds out they are not
// authorized, so it is the moment the authorization starts — the answer IS the URL. Nothing opens a
// browser: `open` would start one wherever the SERVER runs, which in Cowork may be a VM nobody is
// looking at, while a person who clicks always clicks on their own device with their own Zendesk
// session (decision D3).

const emptyStore = { load: () => null, save: () => {}, clear: () => {} } as unknown as TokenStore;

const storedTokens = (tokens: StoredTokens): TokenStore =>
  ({ load: () => tokens, save: () => {}, clear: () => {} }) as unknown as TokenStore;

// For the two cases that do not go through a real file: a store that cannot be decrypted at all.
const unreadableStore = {
  load: () => {
    throw new Error('Unsupported state or unable to authenticate data');
  },
  save: () => {},
  clear: () => {},
} as unknown as TokenStore;

// A listener that binds nothing and never settles: these cases are about what the FIRST call answers
// and about how many listeners were asked for, not about the redirect coming back.
function countingListen(counted: { listeners: number }): NonNullable<LoginDeps['listen']> {
  return async (): Promise<CallbackListener> => {
    counted.listeners += 1;
    return { promise: new Promise<never>(() => {}), close: () => {}, addresses: ['127.0.0.1', '::1'] };
  };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

describe('the token boundary without credentials', () => {
  it('answers the first tool call with the authorization URL, and with nothing else', async () => {
    const port = freePort();
    const counted = { listeners: 0 };
    const login = deps(port, { listen: countingListen(counted) });
    const manager = new AuthManager(emptyStore, config(port), undefined, () => runLogin(login));

    const answer = await manager.getAccessToken().then(() => 'resolved', message);

    const url = authorizationUrl(answer);
    expect(url.host).toBe('acme.zendesk.com');
    // Exactly the authorization URL's own parameters: no token, no code, no secret, nothing a caller
    // could mistake for a credential, and no second URL in the text either.
    expect([...url.searchParams.keys()].sort()).toEqual([
      'client_id',
      'code_challenge',
      'code_challenge_method',
      'redirect_uri',
      'response_type',
      'scope',
      'state',
    ]);
    expect(answer.match(/https:\/\//g)).toHaveLength(1);
    expect(answer).not.toMatch(/secret|access_token|refresh/i);
    expect(counted.listeners).toBe(1);
  });

  // The lock is the queue in src/tools/login.ts: the second caller must COLLECT the flow the first
  // one started, not race a rival listener onto the same port with a state of its own.
  it('starts ONE login and binds ONE listener for two concurrent tool calls', async () => {
    const port = freePort();
    const counted = { listeners: 0 };
    const login = deps(port, { listen: countingListen(counted) });
    const manager = new AuthManager(emptyStore, config(port), undefined, () => runLogin(login));

    const [first, second] = await Promise.all([
      manager.getAccessToken().then(() => 'resolved', message),
      manager.getAccessToken().then(() => 'resolved', message),
    ]);

    expect(counted.listeners).toBe(1);
    // One flow, so one `state` — the second answer repeats the URL the first handed out rather than
    // invalidating it.
    expect(authorizationUrl(second).searchParams.get('state')).toBe(
      authorizationUrl(first).searchParams.get('state'),
    );
    expect(second).toMatch(/still waiting/i);
  });

  it('shares that one flow with zendesk_login, in either order', async () => {
    const port = freePort();
    const counted = { listeners: 0 };
    const login = deps(port, { listen: countingListen(counted) });
    const manager = new AuthManager(emptyStore, config(port), undefined, () => runLogin(login));

    const fromTool = await manager.getAccessToken().then(() => 'resolved', message);
    const fromLogin = await runLogin(login);

    expect(counted.listeners).toBe(1);
    expect(authorizationUrl(fromLogin).searchParams.get('state')).toBe(
      authorizationUrl(fromTool).searchParams.get('state'),
    );
  });

  // The real file, with the real store on both sides: this is the "changed key" case, and no
  // migration code exists for it on purpose — a clean re-authorization is the whole remedy.
  it('starts the authorization for a store the current key cannot decrypt, with no path and no crash', async () => {
    const port = freePort();
    const counted = { listeners: 0 };
    const login = deps(port, { listen: countingListen(counted) });
    writeFileSync(login.tokensPath, 'written-with-a-key-this-process-does-not-have');
    const manager = new AuthManager(
      new TokenStore(login.tokensPath, login.tokenStoreKey),
      config(port),
      undefined,
      () => runLogin(login),
    );

    const answer = await manager.getAccessToken().then(() => 'resolved', message);

    expect(answer).toMatch(/could not be read/i);
    expect(authorizationUrl(answer).host).toBe('acme.zendesk.com');
    expect(answer).not.toContain(login.tokensPath);
    expect(answer).not.toMatch(/\bat .*\.(ts|js):\d+/);
    expect(counted.listeners).toBe(1);
  });

  it('starts nothing at all while there are usable credentials', async () => {
    const port = freePort();
    const counted = { listeners: 0 };
    const login = deps(port, { listen: countingListen(counted) });
    const manager = new AuthManager(
      storedTokens({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000 }),
      config(port),
      undefined,
      () => runLogin(login),
    );

    await expect(manager.getAccessToken()).resolves.toBe('at-1');
    expect(counted.listeners).toBe(0);
  });

  // The CLI and the remote bridge pass no starter: there, naming the tool is all the answer can do.
  it('names the login tool instead when nothing can start a login from here', async () => {
    const port = freePort();
    await expect(new AuthManager(emptyStore, config(port)).getAccessToken()).rejects.toThrow(
      /No Zendesk authorization found\. Run the zendesk_login tool/,
    );
    await expect(new AuthManager(unreadableStore, config(port)).getAccessToken()).rejects.toThrow(
      /could not be read .* Run the zendesk_login tool to re-authorize/s,
    );
  });
});
