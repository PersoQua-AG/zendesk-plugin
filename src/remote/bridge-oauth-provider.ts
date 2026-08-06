import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { buildAuthorizationUrl, exchangeCodeForTokens, type OAuthConfig } from '../auth/oauth-flow.js';
import { fetchZendeskIdentity } from './zendesk-identity.js';
import type { IdentityAuthResolver } from '../auth/identity-resolver.js';
import type { IssuedTokenStore } from '../auth/issued-token-store.js';

// Bridges claude.ai (downstream) to Zendesk (upstream). claude.ai never receives Zendesk tokens:
// we persist those server-side (encrypted, per identity) and hand claude.ai an opaque token bound
// to that identity. Zendesk performs the actual PKCE validation, so we forward the verifier and
// skip local PKCE (skipLocalPkceValidation = true, per the SDK's guidance for upstream-validated
// flows). The precise redirect/registration wiring is contract-gated by Task 0; this logic is
// stable regardless (see connector-contract.ts).
export class ZendeskBridgeOAuthProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = true;

  constructor(
    private readonly config: OAuthConfig,
    private readonly resolver: IdentityAuthResolver,
    private readonly issued: IssuedTokenStore,
    private readonly clients: OAuthRegisteredClientsStore,
    private readonly fetchImpl: typeof fetch = fetch,
    // Server's PUBLIC upstream redirect_uri — MUST be byte-identical at authorize and at exchange
    // or Zendesk rejects the token request (redirect_uri mismatch).
    private readonly callbackUrl: string = '',
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.clients;
  }

  async authorize(_client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Refuse an authorize without PKCE — never forward an empty challenge to Zendesk (M4).
    if (!params.codeChallenge) throw new Error('code_challenge is required (PKCE).');
    const state = params.state ?? randomBytes(16).toString('hex');
    // Stash the downstream redirect keyed by state (single-use, TTL) so the Zendesk callback can
    // complete the exchange and the state is verified as anti-CSRF.
    this.issued.pendingRedirect(state, params.redirectUri);
    res.redirect(buildAuthorizationUrl(this.config, params.codeChallenge, state, this.callbackUrl));
  }

  async challengeForAuthorizationCode(): Promise<string> {
    // PKCE is validated upstream by Zendesk (skipLocalPkceValidation = true), so the SDK never
    // calls this. Fail loudly if the contract changes rather than silently accept a code.
    throw new Error('local PKCE validation is delegated to Zendesk (skipLocalPkceValidation).');
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    codeVerifier?: string,
    _redirectUri?: string,
  ): Promise<OAuthTokens> {
    // Exchange with the SAME public redirect_uri used at authorize — NOT the downstream client's
    // redirect (Zendesk validates redirect_uri equality across the two legs).
    const tokens = await exchangeCodeForTokens(this.config, code, codeVerifier ?? '', this.callbackUrl, this.fetchImpl);
    const identity = await fetchZendeskIdentity(this.config.subdomain, tokens.accessToken, this.fetchImpl);
    this.resolver.persist(identity, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
    });
    return { access_token: this.issued.mint(identity, client.client_id), token_type: 'Bearer', expires_in: 3600 };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    // Downstream (claude.ai) refresh re-runs authorize; Zendesk-side refresh is transparent via the
    // per-user AuthManager. Pinned by Task 0 if claude.ai turns out to require a refresh grant.
    throw new Error('downstream refresh handled by session re-auth — see connector-contract.ts.');
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { identity, clientId, expiresAt } = this.issued.identityFor(token); // throws → 401 for unknown/expired
    // AuthInfo.expiresAt is epoch-seconds; the store keeps epoch-ms.
    return { token, clientId, scopes: this.config.scopes, expiresAt: Math.floor(expiresAt / 1000), extra: { identity } };
  }
}
