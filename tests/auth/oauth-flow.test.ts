import { describe, it, expect } from 'vitest';
import { buildAuthorizationUrl, waitForAuthorizationCode, type OAuthConfig } from '../../src/auth/oauth-flow.js';

const config: OAuthConfig = {
  subdomain: 'acme',
  clientId: 'client-123',
  clientSecret: 'secret-abc',
  callbackPort: 18976,
  scopes: ['read', 'write'],
};

describe('buildAuthorizationUrl', () => {
  it('builds a Zendesk authorization URL with PKCE params', () => {
    const url = new URL(buildAuthorizationUrl(config, 'challenge-xyz', 'state-1'));
    expect(url.origin).toBe('https://acme.zendesk.com');
    expect(url.pathname).toBe('/oauth/authorizations/new');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:18976/callback');
    expect(url.searchParams.get('scope')).toBe('read write');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('waitForAuthorizationCode', () => {
  it('resolves with the code when the callback matches the expected state', async () => {
    const pending = waitForAuthorizationCode(18977, 'expected-state');
    await fetch('http://localhost:18977/callback?code=auth-code-1&state=expected-state');
    const result = await pending;
    expect(result.code).toBe('auth-code-1');
    expect(result.redirectUri).toBe('http://localhost:18977/callback');
  });

  it('rejects on state mismatch (possible CSRF)', async () => {
    const pending = waitForAuthorizationCode(18978, 'expected-state');
    // Attach the rejection assertion before triggering the callback so the
    // rejection is never momentarily unhandled (which vitest fails the run on).
    const assertion = expect(pending).rejects.toThrow(/state mismatch/i);
    await fetch('http://localhost:18978/callback?code=auth-code-1&state=wrong-state').catch(() => {});
    await assertion;
  });

  it('rejects when Zendesk reports an authorization error', async () => {
    const pending = waitForAuthorizationCode(18979, 'expected-state');
    const assertion = expect(pending).rejects.toThrow(/access_denied/);
    await fetch('http://localhost:18979/callback?error=access_denied').catch(() => {});
    await assertion;
  });
});
