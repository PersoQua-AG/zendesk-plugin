import { describe, it, expect } from 'vitest';
import { defaultDataDir, resolveAuthConfig } from '../../src/auth/config.js';
import { configuredKeychain, deniedKeychain, fakeKeychain, keychain, TEST_STORE_KEY } from './keychain.js';

const fullEnv = (): NodeJS.ProcessEnv => ({
  ZENDESK_SUBDOMAIN: 'acme',
  ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
  ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
});

describe('resolveAuthConfig', () => {
  it('reads subdomain/clientId/clientSecret from env', () => {
    const { config } = resolveAuthConfig(fullEnv(), keychain());
    expect(config.subdomain).toBe('acme');
    expect(config.clientId).toBe('client-abc');
    expect(config.clientSecret).toBe('secret-xyz');
  });

  it('defaults callbackPort to 8976 and honors override', () => {
    expect(resolveAuthConfig(fullEnv(), keychain()).config.callbackPort).toBe(8976);
    const overridden = resolveAuthConfig({ ...fullEnv(), ZENDESK_OAUTH_CALLBACK_PORT: '9000' }, keychain());
    expect(overridden.config.callbackPort).toBe(9000);
  });

  it('treats an empty-string callback port as absent (Number("")===0 would bind port 0)', () => {
    const { config } = resolveAuthConfig({ ...fullEnv(), ZENDESK_OAUTH_CALLBACK_PORT: '' }, keychain());
    expect(config.callbackPort).toBe(8976);
  });

  it('treats an empty-string ZENDESK_DATA_DIR as absent (""→tokens.enc at fs root)', () => {
    const resolved = resolveAuthConfig({ ...fullEnv(), ZENDESK_DATA_DIR: '' }, keychain());
    expect(resolved.dataDir).toBe(defaultDataDir(fullEnv()));
    expect(resolved.tokensPath).toBe(`${defaultDataDir(fullEnv())}/tokens.enc`);
  });

  it('uses read/write scopes (server source of truth)', () => {
    expect(resolveAuthConfig(fullEnv(), keychain()).config.scopes).toEqual(['read', 'write']);
  });

  it('defaults dataDir and honors ZENDESK_DATA_DIR', () => {
    expect(resolveAuthConfig(fullEnv(), keychain()).dataDir).toBe(defaultDataDir(fullEnv()));
    const overridden = resolveAuthConfig({ ...fullEnv(), ZENDESK_DATA_DIR: '/var/data' }, keychain());
    expect(overridden.dataDir).toBe('/var/data');
  });

  it('server + bin resolve the identical TokenStore path + key from the same env', () => {
    // Both server.ts and bin/authorize.ts derive the token store from
    // resolveAuthConfig(process.env); given one env they must never diverge, or
    // the bin writes tokens the server cannot find. The KEY no longer comes from the env at all —
    // it comes from the one Keychain item (src/auth/store-key.ts), which is what makes rotating the
    // client secret harmless; what still has to hold is that both callers read that same one value.
    const env = { ...fullEnv(), ZENDESK_DATA_DIR: '/var/data' };
    const forServer = resolveAuthConfig(env, keychain());
    const forBin = resolveAuthConfig(env, keychain());
    expect(forServer.tokensPath).toBe('/var/data/tokens.enc');
    expect(forBin.tokensPath).toBe(forServer.tokensPath); // identical path
    expect(forBin.tokenStoreKey).toBe(forServer.tokenStoreKey); // identical TokenStore key
    expect(forServer.tokenStoreKey).toBe(TEST_STORE_KEY);
  });

  it('reads the store key once per resolution, however many times it is read', () => {
    const fake = fakeKeychain({ items: { 'token-store-key': TEST_STORE_KEY } });
    const resolved = resolveAuthConfig(fullEnv(), fake.run);
    expect([resolved.tokenStoreKey, resolved.tokenStoreKey]).toEqual([TEST_STORE_KEY, TEST_STORE_KEY]);
    expect(fake.calls).toHaveLength(1);
  });

  // A public OAuth client has no secret; PKCE authenticates the exchange instead (#68). The field is
  // therefore absent rather than empty, so the request body can leave it out entirely.
  it('leaves clientSecret undefined when none is configured, and when it is blank', () => {
    const without = fullEnv();
    delete without.ZENDESK_OAUTH_CLIENT_SECRET;
    expect(resolveAuthConfig(without, keychain()).config.clientSecret).toBeUndefined();
    expect(
      resolveAuthConfig({ ...fullEnv(), ZENDESK_OAUTH_CLIENT_SECRET: '' }, keychain()).config
        .clientSecret,
    ).toBeUndefined();
  });

  it('rejects a relative ZENDESK_DATA_DIR instead of placing tokens.enc under the working directory', () => {
    expect(() => resolveAuthConfig({ ...fullEnv(), ZENDESK_DATA_DIR: 'data' }, keychain())).toThrow(
      /ZENDESK_DATA_DIR="data" \(must be an absolute path/,
    );
  });

  it.each(['ZENDESK_SUBDOMAIN', 'ZENDESK_OAUTH_CLIENT_ID'])(
    'throws when %s is missing',
    (name) => {
      const env = fullEnv();
      delete env[name];
      expect(() => resolveAuthConfig(env, keychain())).toThrow(
        `Missing required environment variable: ${name}`,
      );
    },
  );
});

// Env WINS over the Keychain, so Claude Code with environment variables behaves exactly as it did
// before the first-run page existed, and an install can always be overridden from outside.
describe('the Keychain as the second source of the three OAuth values', () => {
  it('fills what the environment does not carry', () => {
    const { config } = resolveAuthConfig({}, configuredKeychain());
    expect(config.subdomain).toBe('stored-sub');
    expect(config.clientId).toBe('stored-id');
    expect(config.clientSecret).toBe('stored-secret');
  });

  it('never overrides a value the environment carries', () => {
    const { config } = resolveAuthConfig(fullEnv(), configuredKeychain());
    expect(config.subdomain).toBe('acme');
    expect(config.clientId).toBe('client-abc');
    expect(config.clientSecret).toBe('secret-xyz');
  });

  // Not an optimization: a fully env-configured install must not be breakable by a locked keychain, so
  // it must not ask one. Counted at the seam, which is where the real reader would reach it.
  it('is not even asked when the environment is complete', () => {
    const fake = fakeKeychain({ items: { 'token-store-key': TEST_STORE_KEY } });
    const resolved = resolveAuthConfig(fullEnv(), fake.run);
    expect(resolved.config.subdomain).toBe('acme');
    expect(fake.calls.filter((call) => call.args.includes('oauth-subdomain'))).toEqual([]);
  });

  it('lets a keychain that cannot be read fail the resolution, rather than reading as empty', () => {
    expect(() => resolveAuthConfig({}, deniedKeychain())).toThrow(/could not be read/);
  });

  // GATE-GAP 12: a stored subdomain is DROPPED when it is unusable rather than quoted back. The message
  // is tool output, and the owner decided the customer's instance name is not to lie around in the open;
  // dropping it also makes the configuration incomplete again, which is what gets the setup page offered
  // instead of a start that fails on a value nobody can see or correct.
  it('drops an unusable stored subdomain instead of echoing it into the error', () => {
    const security = configuredKeychain({ ZENDESK_SUBDOMAIN: 'secret-instance.zendesk.com' });
    let thrown = '';
    try {
      resolveAuthConfig({}, security);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown).toContain('Missing required environment variable: ZENDESK_SUBDOMAIN');
    expect(thrown).not.toContain('secret-instance');
  });

  // An env value still is echoed: it is the user's own, it is visible in the manifest or the shell that
  // set it, and seeing the typo is how they fix it.
  it('still echoes an env subdomain, which is where a typo can be seen and corrected', () => {
    expect(() => resolveAuthConfig({ ZENDESK_SUBDOMAIN: 'acme.zendesk.com' }, keychain())).toThrow(
      /ZENDESK_SUBDOMAIN="acme\.zendesk\.com"/,
    );
  });
});
