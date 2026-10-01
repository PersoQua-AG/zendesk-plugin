import { describe, it, expect } from 'vitest';
import { defaultDataDir, resolveAuthConfig } from '../../src/auth/config.js';
import { readStoreKey, TEST_STORE_KEY } from './store-key-stub.js';

const fullEnv = (): NodeJS.ProcessEnv => ({
  ZENDESK_SUBDOMAIN: 'acme',
  ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
  ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
});

describe('resolveAuthConfig', () => {
  it('reads subdomain/clientId/clientSecret from env', () => {
    const { config } = resolveAuthConfig(fullEnv());
    expect(config.subdomain).toBe('acme');
    expect(config.clientId).toBe('client-abc');
    expect(config.clientSecret).toBe('secret-xyz');
  });

  it('defaults callbackPort to 8976 and honors override', () => {
    expect(resolveAuthConfig(fullEnv()).config.callbackPort).toBe(8976);
    const overridden = resolveAuthConfig({ ...fullEnv(), ZENDESK_OAUTH_CALLBACK_PORT: '9000' });
    expect(overridden.config.callbackPort).toBe(9000);
  });

  it('treats an empty-string callback port as absent (Number("")===0 would bind port 0)', () => {
    const { config } = resolveAuthConfig({ ...fullEnv(), ZENDESK_OAUTH_CALLBACK_PORT: '' });
    expect(config.callbackPort).toBe(8976);
  });

  it('treats an empty-string CLAUDE_PLUGIN_DATA as absent (""→tokens.enc at fs root)', () => {
    const resolved = resolveAuthConfig({ ...fullEnv(), CLAUDE_PLUGIN_DATA: '' });
    expect(resolved.dataDir).toBe(defaultDataDir(fullEnv()));
    expect(resolved.tokensPath).toBe(`${defaultDataDir(fullEnv())}/tokens.enc`);
  });

  it('uses read/write scopes (server source of truth)', () => {
    expect(resolveAuthConfig(fullEnv()).config.scopes).toEqual(['read', 'write']);
  });

  it('defaults dataDir and honors CLAUDE_PLUGIN_DATA', () => {
    expect(resolveAuthConfig(fullEnv()).dataDir).toBe(defaultDataDir(fullEnv()));
    const overridden = resolveAuthConfig({ ...fullEnv(), CLAUDE_PLUGIN_DATA: '/var/data' });
    expect(overridden.dataDir).toBe('/var/data');
  });

  it('server + bin resolve the identical TokenStore path + key from the same env', () => {
    // Both server.ts and bin/authorize.ts derive the token store from
    // resolveAuthConfig(process.env); given one env they must never diverge, or
    // the bin writes tokens the server cannot find. The KEY no longer comes from the env at all —
    // it comes from the one Keychain item (src/auth/store-key.ts), which is what makes rotating the
    // client secret harmless; what still has to hold is that both callers read that same one value.
    const env = { ...fullEnv(), CLAUDE_PLUGIN_DATA: '/var/data' };
    const forServer = resolveAuthConfig(env, readStoreKey);
    const forBin = resolveAuthConfig(env, readStoreKey);
    expect(forServer.tokensPath).toBe('/var/data/tokens.enc');
    expect(forBin.tokensPath).toBe(forServer.tokensPath); // identical path
    expect(forBin.tokenStoreKey).toBe(forServer.tokenStoreKey); // identical TokenStore key
    expect(forServer.tokenStoreKey).toBe(TEST_STORE_KEY);
  });

  it('reads the store key once per resolution, however many times it is read', () => {
    let calls = 0;
    const resolved = resolveAuthConfig(fullEnv(), () => {
      calls += 1;
      return TEST_STORE_KEY;
    });
    expect([resolved.tokenStoreKey, resolved.tokenStoreKey]).toEqual([TEST_STORE_KEY, TEST_STORE_KEY]);
    expect(calls).toBe(1);
  });

  // A public OAuth client has no secret; PKCE authenticates the exchange instead (#68). The field is
  // therefore absent rather than empty, so the request body can leave it out entirely.
  it('leaves clientSecret undefined when none is configured, and when it is blank', () => {
    const without = fullEnv();
    delete without.ZENDESK_OAUTH_CLIENT_SECRET;
    expect(resolveAuthConfig(without, readStoreKey).config.clientSecret).toBeUndefined();
    expect(
      resolveAuthConfig({ ...fullEnv(), ZENDESK_OAUTH_CLIENT_SECRET: '' }, readStoreKey).config.clientSecret,
    ).toBeUndefined();
  });

  it('rejects a relative CLAUDE_PLUGIN_DATA instead of placing tokens.enc under the working directory', () => {
    expect(() => resolveAuthConfig({ ...fullEnv(), CLAUDE_PLUGIN_DATA: 'data' }, readStoreKey)).toThrow(
      /CLAUDE_PLUGIN_DATA="data" \(must be an absolute path/,
    );
  });

  it.each(['ZENDESK_SUBDOMAIN', 'ZENDESK_OAUTH_CLIENT_ID'])(
    'throws when %s is missing',
    (name) => {
      const env = fullEnv();
      delete env[name];
      expect(() => resolveAuthConfig(env)).toThrow(`Missing required environment variable: ${name}`);
    },
  );
});
