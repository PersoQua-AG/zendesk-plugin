import { randomBytes } from 'node:crypto';
import { InvalidGrantError, InvalidScopeError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { buildAuthorizationUrl, exchangeCodeForTokens } from '../auth/oauth-flow.js';
import { fetchZendeskIdentity } from './zendesk-identity.js';
import { RefreshTokenReplayError, RefreshInFlightError } from '../auth/refresh-token-store.js';
import { log } from './logger.js';
import { describeAuthError } from './error-messages.js';
// The single refusal the client ever sees on the refresh grant. ASCII only: it rides in an OAuth
// error body and, on the bearer path, in a latin1-only header. It names no token and no check.
const REFRESH_REFUSED = 'Refresh token is invalid, expired, already used, or the Zendesk session ended - re-authorize the Zendesk connector.';
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
    callbackUrl;
    refreshTokens;
    skipLocalPkceValidation = true;
    constructor(config, resolver, issued, clients, fetchImpl = fetch, 
    // Server's PUBLIC upstream redirect_uri — MUST be byte-identical at authorize and at exchange
    // or Zendesk rejects the token request (redirect_uri mismatch).
    callbackUrl = '', 
    // Downstream refresh grant (M9). Its PRESENCE is the contract gate: when the pinned connector
    // contract says claude.ai does not use a refresh grant, remote-server passes nothing and the
    // grant is inert — no refresh_token is minted and every refresh attempt is refused.
    // A store SEPARATE from `issued`: two namespaces on disk, so an access token can never be
    // spent as a refresh token nor a refresh token presented as a bearer.
    refreshTokens) {
        this.config = config;
        this.resolver = resolver;
        this.issued = issued;
        this.clients = clients;
        this.fetchImpl = fetchImpl;
        this.callbackUrl = callbackUrl;
        this.refreshTokens = refreshTokens;
    }
    get clientsStore() {
        return this.clients;
    }
    async authorize(_client, params, res) {
        // Refuse an authorize without PKCE — never forward an empty challenge to Zendesk (M4).
        if (!params.codeChallenge)
            throw new Error('code_challenge is required (PKCE).');
        const state = params.state ?? randomBytes(16).toString('hex');
        // Stash the downstream redirect keyed by state (single-use, TTL) so the Zendesk callback can
        // complete the exchange and the state is verified as anti-CSRF.
        this.issued.pendingRedirect(state, params.redirectUri);
        res.redirect(buildAuthorizationUrl(this.config, params.codeChallenge, state, this.callbackUrl));
    }
    async challengeForAuthorizationCode() {
        // PKCE is validated upstream by Zendesk (skipLocalPkceValidation = true), so the SDK never
        // calls this. Fail loudly if the contract changes rather than silently accept a code.
        throw new Error('local PKCE validation is delegated to Zendesk (skipLocalPkceValidation).');
    }
    async exchangeAuthorizationCode(client, code, codeVerifier, _redirectUri) {
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
    //
    // `resource` is ignored: this server advertises exactly one resource (CONNECTOR.resourceUrl), so
    // there is nothing to narrow to. `scopes` may not WIDEN the grant (RFC 6749 §6) and we do not
    // implement narrowing either — a request for anything outside the connector's configured scopes
    // is refused rather than silently granted as something else. The response echoes what was granted.
    async exchangeRefreshToken(client, refreshToken, scopes) {
        const store = this.refreshTokens;
        if (!store) {
            throw new InvalidGrantError('Refresh grant is not enabled - re-authorize the Zendesk connector.');
        }
        const unknown = scopes?.filter((s) => !this.config.scopes.includes(s)) ?? [];
        if (unknown.length > 0) {
            // Count, not contents: the requested strings are client-supplied and have no place in a log.
            log({ msg: `refresh refused: ${unknown.length} requested scope(s) outside the granted set`, outcome: '400' });
            throw new InvalidScopeError('Requested scope exceeds the scope granted to this connector.');
        }
        let outcome;
        try {
            outcome = store.consume(refreshToken); // atomic single-use; unknown/expired/replayed -> throws
        }
        catch (err) {
            throw this.refuseConsume(err);
        }
        if (outcome.kind === 'repeat') {
            // The same request asked again inside the grace window — a lost 200, a retry, a second tab.
            // Answering it with the SAME bytes is what keeps an ordinary OAuth client from being logged
            // out by its own correct retry behaviour. No mint, no rotation, no new state.
            //
            // The liveness probe is deliberately NOT run here, and that is not an oversight to be tidied
            // away later: no new grant is being issued. These are bytes already handed out once, inside a
            // ten-second window, and the Zendesk session was checked when they were minted. Probing again
            // would turn a retry into a second upstream call for nothing.
            if (outcome.clientId !== client.client_id)
                return this.refuseClientMismatch(store, outcome.chainId);
            log({ msg: 'refresh repeated: same response returned inside the grace window', outcome: '200' });
            return this.parseRepeat(outcome.payload);
        }
        const rec = outcome.record;
        // Token substitution: a grant minted for one registered client must not be spendable by another.
        // The token was genuine but is in the wrong hands — the same theft signal as a replay, so the
        // family goes with it.
        if (rec.clientId !== client.client_id)
            this.refuseClientMismatch(store, rec.chainId);
        try {
            // Liveness: the mapped identity must still resolve to usable Zendesk credentials.
            // getAccessToken() can reject (dead upstream grant) OR throw synchronously (store
            // construction) — both are a refusal, never a 500.
            await this.resolver.forIdentity(rec.identity).getAccessToken();
        }
        catch (err) {
            log({ msg: `refresh refused: no live Zendesk session - ${describeAuthError(err)}`, outcome: '400' });
            throw new InvalidGrantError(REFRESH_REFUSED);
        }
        try {
            // Rotation stays inside the SAME chain, so a later replay revokes every descendant of the
            // token that was stolen and nothing else.
            const tokens = this.mintTokens(rec.identity, client.client_id, rec);
            // File the receipt so the client's retry gets this same answer instead of a revoked chain.
            store.rememberRepeat(refreshToken, JSON.stringify(tokens), client.client_id);
            log({ msg: 'refresh granted: access token rotated without re-authorization', outcome: '200' });
            return tokens;
        }
        catch (err) {
            // BLOCKER fix: minting writes files, and writeFileSync throws (ENOSPC, EACCES). Outside this
            // catch a bare Error reaches the SDK handler as a ServerError -> HTTP 500, which is the one
            // status an OAuth client does NOT re-authorize on — and the presented token is already spent,
            // so the chain is gone and the client would retry into the same 500 forever. Refuse as
            // invalid_grant so the client re-authorizes, and log the real cause so it is diagnosable.
            log({ msg: `refresh mint failed after the grant was spent: ${describeAuthError(err)}`, outcome: '400' });
            throw new InvalidGrantError(REFRESH_REFUSED);
        }
    }
    // A client substitution is a client substitution. It used to be answered one way on the spend
    // path (revoke the family) and another inside the grace window (refuse only) — the same signal,
    // a weaker answer, purely because of when it arrived. Never returns: the signature says so, so
    // the two call sites read alike.
    refuseClientMismatch(store, chainId) {
        const revoked = store.revokeChain(chainId);
        log({ msg: `refresh refused: presented by a different client, rotation chain revoked (${revoked} live token(s))`, outcome: '400' });
        throw new InvalidGrantError(REFRESH_REFUSED);
    }
    // The payload is bytes this server wrote and encrypted, so a parse failure is a corrupt store,
    // not client input — but it must still leave by the refusal door rather than as a 500.
    parseRepeat(payload) {
        try {
            return JSON.parse(payload);
        }
        catch {
            throw new InvalidGrantError(REFRESH_REFUSED);
        }
    }
    // One opaque message for every refusal: it must not tell an attacker which check failed, and it
    // carries no token material. The DISTINCTION lives in the log line, not in the response — a bare
    // `catch {}` here would turn a programming error into an endless, diagnosis-free re-auth loop.
    refuseConsume(err) {
        if (err instanceof RefreshTokenReplayError) {
            // A rotated token presented a second time is the classic stolen-chain indicator
            // (RFC 6819 5.2.2.3). consume() has already revoked the family; say how much it took.
            // Repeats against an ALREADY-dead chain are not logged: the chain was recorded as dead at the
            // first detection, so every further attempt adds no information — and this path is reachable
            // without credentials, so one log line per attempt is an amplifier of its own.
            if (!err.alreadyDead) {
                log({ msg: `refresh refused: rotation replay detected, chain revoked (${err.revoked} live token(s))`, outcome: '400' });
            }
        }
        else if (err instanceof RefreshInFlightError) {
            // Concurrency, not theft. Logged as its own outcome so a burst of these is never read as an
            // attack, and — the part that matters — no chain was revoked to produce it.
            log({ msg: 'refresh refused: another spend of this token is already in progress', outcome: '400' });
        }
        else if (err instanceof InvalidTokenError) {
            log({ msg: `refresh refused: ${describeAuthError(err)}`, outcome: '400' });
        }
        else {
            // Not one of the store's refusal types: an I/O failure or a bug on this path. Still a refusal
            // for the client (AC4: never a 500), but it must be visible in the log as what it is.
            log({ msg: `refresh refused on an unexpected internal error: ${describeAuthError(err)}`, outcome: '400' });
        }
        return new InvalidGrantError(REFRESH_REFUSED);
    }
    // expires_in is the lifetime the issued store actually enforces, read from the store itself, so
    // the advertised number cannot drift away from the one that expires the token.
    mintTokens(identity, clientId, rotating) {
        const tokens = {
            access_token: this.issued.mint(identity, clientId),
            token_type: 'Bearer',
            expires_in: this.issued.ttlSeconds,
            scope: this.config.scopes.join(' '),
        };
        // Rotation stays inside the SAME family and inherits its absolute deadline; a fresh login
        // starts a new one. Either way a family holds exactly one live token, which is what lets a
        // replay be answered without reading the directory.
        if (this.refreshTokens) {
            tokens.refresh_token = rotating
                ? this.refreshTokens.rotate(rotating, clientId)
                : this.refreshTokens.mint(identity, clientId);
        }
        return tokens;
    }
    async verifyAccessToken(token) {
        const { identity, clientId, expiresAt } = this.issued.identityFor(token); // throws → 401 for unknown/expired
        // AuthInfo.expiresAt is epoch-seconds; the store keeps epoch-ms.
        return { token, clientId, scopes: this.config.scopes, expiresAt: Math.floor(expiresAt / 1000), extra: { identity } };
    }
}
