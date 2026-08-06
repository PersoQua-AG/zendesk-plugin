import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { IdentityTokenStore } from '../../src/auth/identity-store.js';
import { IdentityAuthResolver } from '../../src/auth/identity-resolver.js';
import { IssuedTokenStore } from '../../src/auth/issued-token-store.js';
import { ZendeskBridgeOAuthProvider } from '../../src/remote/bridge-oauth-provider.js';
import { CONNECTOR } from '../../src/remote/connector-contract.js';
import type { OAuthConfig } from '../../src/auth/oauth-flow.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const config: OAuthConfig = {
  subdomain: 'acme',
  clientId: 'cid',
  clientSecret: 'server-secret',
  callbackPort: 8976,
  scopes: ['read', 'write'],
};

const client = { client_id: 'claude.ai' } as OAuthClientInformationFull;
const CALLBACK_URL = 'https://connector.example.eu/callback';

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'zd-bridge-'));
  dirs.push(dir);
  const resolver = new IdentityAuthResolver(new IdentityTokenStore(join(dir, 'users'), config.clientSecret), config);
  const issued = new IssuedTokenStore(join(dir, 'issued'), config.clientSecret);
  let tokenExchangeRedirect: string | undefined;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    if (u.includes('/oauth/tokens')) {
      tokenExchangeRedirect = (JSON.parse(String(init.body)) as { redirect_uri?: string }).redirect_uri;
      return new Response(JSON.stringify({ access_token: 'zd-at', refresh_token: 'zd-rt', expires_in: 3600 }), { status: 200 });
    }
    if (u.includes('/users/me.json')) {
      return new Response(JSON.stringify({ user: { id: 777 } }), { status: 200 });
    }
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  const provider = new ZendeskBridgeOAuthProvider(config, resolver, issued, CONNECTOR.clientsStore(), fetchImpl, CALLBACK_URL);
  return { provider, resolver, issued, tokenExchangeRedirect: () => tokenExchangeRedirect };
}

describe('ZendeskBridgeOAuthProvider', () => {
  it('authorize redirects to the Zendesk authorize URL with S256 challenge + state', async () => {
    const { provider } = build();
    const redirect = vi.fn();
    const res = { redirect } as unknown as Response;
    const params: AuthorizationParams = { state: 's-123', codeChallenge: 'chal-abc', redirectUri: 'https://claude.ai/cb' };
    await provider.authorize(client, params, res);

    const url = new URL(redirect.mock.calls[0][0] as string);
    expect(url.origin).toBe('https://acme.zendesk.com');
    expect(url.pathname).toBe('/oauth/authorizations/new');
    expect(url.searchParams.get('code_challenge')).toBe('chal-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('s-123');
    // Authorize leg advertises the PUBLIC callback, NOT localhost.
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK_URL);
  });

  it('exchanges a code for Zendesk tokens, persists them per-identity, and mints an opaque token', async () => {
    const { provider, resolver, tokenExchangeRedirect } = build();
    // The downstream redirect_uri the SDK passes must be IGNORED for the Zendesk exchange.
    const tokens = await provider.exchangeAuthorizationCode(client, 'zcode', 'verifier', 'https://claude.ai/cb');

    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token).toMatch(/^[0-9a-f]{64}$/); // opaque, not the Zendesk token
    expect(tokens.access_token).not.toBe('zd-at');
    // Token leg uses the SAME public callback as the authorize leg (Zendesk enforces equality).
    expect(tokenExchangeRedirect()).toBe(CALLBACK_URL);

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.extra?.identity).toBe('zendesk:777');
    expect(info.clientId).toBe('claude.ai'); // the real DCR client id from the exchange, not a literal
    expect(info.scopes).toEqual(['read', 'write']);
    // Zendesk tokens landed in the per-user store, keyed by identity.
    await expect(resolver.forIdentity('zendesk:777').getAccessToken()).resolves.toBe('zd-at');
  });

  it('rejects an unknown/expired opaque token (→ 401)', async () => {
    const { provider } = build();
    await expect(provider.verifyAccessToken('deadbeef')).rejects.toThrow(/re-authorize/i);
  });

  it('refuses an unknown OAuth state (CSRF discipline)', () => {
    const { issued } = build();
    issued.pendingRedirect('good-state', 'https://claude.ai/cb');
    expect(() => issued.consumePendingRedirect('forged-state')).toThrow(/CSRF/i);
    expect(issued.consumePendingRedirect('good-state')).toEqual({ redirectUri: 'https://claude.ai/cb' });
  });

  it('refuses authorize without a PKCE code_challenge (M4)', async () => {
    const { provider } = build();
    const res = { redirect: vi.fn() } as unknown as Response;
    const params = { state: 's-1', redirectUri: 'https://claude.ai/cb' } as AuthorizationParams;
    await expect(provider.authorize(client, params, res)).rejects.toThrow(/code_challenge/i);
  });

  it('rejects a duplicate live pending authorize state (single-use CSRF discipline)', () => {
    const { issued } = build();
    issued.pendingRedirect('dup-state', 'https://claude.ai/cb');
    expect(() => issued.pendingRedirect('dup-state', 'https://claude.ai/cb')).toThrow(/CSRF|colliding/i);
  });
});
