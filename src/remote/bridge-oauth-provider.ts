import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
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
    // Downstream refresh grant (M9). Its PRESENCE is the contract gate: when the pinned connector
    // contract says claude.ai does not use a refresh grant, remote-server passes nothing and the
    // grant is inert — no refresh_token is minted and every refresh attempt is refused.
    // A store SEPARATE from `issued`: two namespaces on disk, so an access token can never be
    // spent as a refresh token nor a refresh token presented as a bearer.
    private readonly refreshTokens?: IssuedTokenStore,
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
    return this.mintTokens(identity, client.client_id);
  }

  // Lets claude.ai renew its opaque access token without a browser authorize, for as long as the
  // underlying per-user Zendesk session is still usable. Single-use with rotation: the presented
  // token is spent BEFORE anything else can fail, so a refused refresh leaves no replay window.
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    if (!this.refreshTokens) {
      throw new InvalidGrantError('Refresh grant is not enabled - re-authorize the Zendesk connector.');
    }
    let identity: string;
    try {
      const rec = this.refreshTokens.consume(refreshToken); // unknown/expired/reused -> throws
      // Token substitution: a grant minted for one registered client must not be spendable by another.
      if (rec.clientId !== client.client_id) throw new Error('refresh token was issued to a different client');
      // Liveness: the mapped identity must still resolve to a usable Zendesk session. getAccessToken()
      // can reject (dead upstream grant) OR throw synchronously (store construction) — both are a
      // refusal, never a 500.
      await this.resolver.forIdentity(rec.identity).getAccessToken();
      identity = rec.identity;
    } catch {
      // One opaque message for every refusal: it must not tell an attacker which check failed, and
      // it carries no token material. ASCII only (it rides in an OAuth error body).
      throw new InvalidGrantError('Refresh token is invalid, expired, already used, or the Zendesk session ended - re-authorize the Zendesk connector.');
    }
    return this.mintTokens(identity, client.client_id);
  }

  // expires_in is the lifetime the issued store actually enforces, read from the store itself, so
  // the advertised number cannot drift away from the one that expires the token.
  private mintTokens(identity: string, clientId: string): OAuthTokens {
    const tokens: OAuthTokens = {
      access_token: this.issued.mint(identity, clientId),
      token_type: 'Bearer',
      expires_in: this.issued.ttlSeconds,
    };
    if (this.refreshTokens) tokens.refresh_token = this.refreshTokens.mint(identity, clientId);
    return tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { identity, clientId, expiresAt } = this.issued.identityFor(token); // throws → 401 for unknown/expired
    // AuthInfo.expiresAt is epoch-seconds; the store keeps epoch-ms.
    return { token, clientId, scopes: this.config.scopes, expiresAt: Math.floor(expiresAt / 1000), extra: { identity } };
  }
}
