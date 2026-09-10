import { describe, it, expect } from 'vitest';
import { defaultDataDir, resolveAuthConfig } from '../../src/auth/config.js';

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
    // the bin writes tokens the server cannot find.
    const env = { ...fullEnv(), CLAUDE_PLUGIN_DATA: '/var/data' };
    const forServer = resolveAuthConfig(env);
    const forBin = resolveAuthConfig(env);
    expect(forServer.tokensPath).toBe('/var/data/tokens.enc');
    expect(forBin.tokensPath).toBe(forServer.tokensPath); // identical path
    expect(forBin.config.clientSecret).toBe(forServer.config.clientSecret); // identical TokenStore key source
  });

  it.each(['ZENDESK_SUBDOMAIN', 'ZENDESK_OAUTH_CLIENT_ID', 'ZENDESK_OAUTH_CLIENT_SECRET'])(
    'throws when %s is missing',
    (name) => {
      const env = fullEnv();
      delete env[name];
      expect(() => resolveAuthConfig(env)).toThrow(`Missing required environment variable: ${name}`);
    },
  );
});
