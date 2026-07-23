import { describe, it, expect } from 'vitest';
import { resolveAuthConfig } from '../../src/auth/config.js';

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

  it('uses read/write scopes (server source of truth)', () => {
    expect(resolveAuthConfig(fullEnv()).config.scopes).toEqual(['read', 'write']);
  });

  it('defaults dataDir and honors CLAUDE_PLUGIN_DATA', () => {
    expect(resolveAuthConfig(fullEnv()).dataDir).toBe('.zendesk-plugin-data');
    const overridden = resolveAuthConfig({ ...fullEnv(), CLAUDE_PLUGIN_DATA: '/var/data' });
    expect(overridden.dataDir).toBe('/var/data');
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
