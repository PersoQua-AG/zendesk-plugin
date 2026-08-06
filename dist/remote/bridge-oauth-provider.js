import { randomBytes } from 'node:crypto';
import { buildAuthorizationUrl, exchangeCodeForTokens } from '../auth/oauth-flow.js';
import { fetchZendeskIdentity } from './zendesk-identity.js';
// Bridges claude.ai (downstream) to Zendesk (upstream). claude.ai never receives Zendesk tokens:
// we persist those server-side (encrypted, per identity) and hand claude.ai an opaque token bound
// to that identity. Zendesk performs the actual PKCE validation, so we forward the verifier and
// skip local PKCE (skipLocalPkceValidation = true, per the SDK's guidance for upstream-validated
// flows). The precise redirect/registration wiring is contract-gated by Task 0; this logic is
// stable regardless (see connector-contract.ts).
export class ZendeskBridgeOAuthProvider {
    config;
    resolver;
    issued;
    clients;
    fetchImpl;
    skipLocalPkceValidation = true;
    constructor(config, resolver, issued, clients, fetchImpl = fetch) {
        this.config = config;
        this.resolver = resolver;
        this.issued = issued;
        this.clients = clients;
        this.fetchImpl = fetchImpl;
    }
    get clientsStore() {
        return this.clients;
    }
    async authorize(_client, params, res) {
        const state = params.state ?? randomBytes(16).toString('hex');
        // Stash the downstream redirect + PKCE challenge keyed by state (single-use, TTL) so the
        // Zendesk callback can complete the exchange and the state is verified as anti-CSRF.
        this.issued.pendingRedirect(state, params.redirectUri, params.codeChallenge);
        res.redirect(buildAuthorizationUrl(this.config, params.codeChallenge, state));
    }
    async challengeForAuthorizationCode() {
        // PKCE is validated upstream by Zendesk (skipLocalPkceValidation = true), so the SDK never
        // calls this. Fail loudly if the contract changes rather than silently accept a code.
        throw new Error('local PKCE validation is delegated to Zendesk (skipLocalPkceValidation).');
    }
    async exchangeAuthorizationCode(_client, code, codeVerifier, redirectUri) {
        const tokens = await exchangeCodeForTokens(this.config, code, codeVerifier ?? '', redirectUri ?? '', this.fetchImpl);
        const identity = await fetchZendeskIdentity(this.config.subdomain, tokens.accessToken, this.fetchImpl);
        this.resolver.persist(identity, {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: Date.now() + tokens.expiresIn * 1000,
        });
        return { access_token: this.issued.mint(identity), token_type: 'Bearer', expires_in: 3600 };
    }
    async exchangeRefreshToken() {
        // Downstream (claude.ai) refresh re-runs authorize; Zendesk-side refresh is transparent via the
        // per-user AuthManager. Pinned by Task 0 if claude.ai turns out to require a refresh grant.
        throw new Error('downstream refresh handled by session re-auth — see connector-contract.ts.');
    }
    async verifyAccessToken(token) {
        const { identity, expiresAt } = this.issued.identityFor(token); // throws → 401 for unknown/expired
        // AuthInfo.expiresAt is epoch-seconds; the store keeps epoch-ms.
        return { token, clientId: 'claude.ai', scopes: this.config.scopes, expiresAt: Math.floor(expiresAt / 1000), extra: { identity } };
    }
}
