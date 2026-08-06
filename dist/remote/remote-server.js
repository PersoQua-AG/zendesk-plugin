import express from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { resolveAuthConfig } from '../auth/config.js';
import { RateLimiter } from '../client/rate-limiter.js';
import { DEFAULT_RATE_LIMIT_RPM, INCREMENTAL_RATE_LIMIT_RPM } from '../server.js';
import { IdentityAuthResolver } from '../auth/identity-resolver.js';
import { IdentityTokenStore } from '../auth/identity-store.js';
import { IssuedTokenStore } from '../auth/issued-token-store.js';
import { ZendeskBridgeOAuthProvider } from './bridge-oauth-provider.js';
import { SessionManager } from './session-manager.js';
import { WriteAuditLog } from './audit-log.js';
import { CONNECTOR } from './connector-contract.js';
import { describeAuthError } from './error-messages.js';
import { log } from './logger.js';
const BODY_LIMIT = '4mb';
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily audit retention sweep (D3/A7)
// Build the remote MCP express app (no listen — callers/tests attach a server). Reuses
// createServer() per session via SessionManager; the stdio entrypoint is untouched.
export function buildRemoteApp(env = process.env, deps = {}) {
    const { config, dataDir } = resolveAuthConfig(env);
    // Data-encryption key is DISTINCT from the OAuth client secret and independently rotatable:
    // rotating the client secret must not brick per-user token files, and the client secret must not
    // double as the decrypt-all key. Required (fail-closed) whenever a default store is constructed.
    const requireEncKey = () => {
        const key = env.REMOTE_TOKEN_ENC_KEY;
        if (!key)
            throw new Error('REMOTE_TOKEN_ENC_KEY is required (data-encryption key for the per-user token stores).');
        return key;
    };
    const resolver = deps.resolver ?? new IdentityAuthResolver(new IdentityTokenStore(`${dataDir}/users`, requireEncKey()), config);
    const issued = deps.issued ?? new IssuedTokenStore(`${dataDir}/issued`, requireEncKey());
    const audit = deps.audit ?? new WriteAuditLog(`${dataDir}/audit/write-audit.jsonl`);
    // Enforce retention at startup, then on an unref'd daily timer so the sweep never holds the
    // process open (D3/A7). No external cron/manual command required.
    audit.prune();
    setInterval(() => audit.prune(), PRUNE_INTERVAL_MS).unref?.();
    // SHARED rate buckets across all sessions — the Zendesk 400/min + 10/min budget is account-wide.
    const rateLimiter = deps.rateLimiter ?? new RateLimiter({ requestsPerMinute: DEFAULT_RATE_LIMIT_RPM });
    const incrementalRateLimiter = deps.incrementalRateLimiter ?? new RateLimiter({ requestsPerMinute: INCREMENTAL_RATE_LIMIT_RPM });
    const sessions = new SessionManager(env, { resolver, rateLimiter, incrementalRateLimiter, dataDir, audit, fetchImpl: deps.fetchImpl });
    const provider = new ZendeskBridgeOAuthProvider(config, resolver, issued, CONNECTOR.clientsStore(), deps.fetchImpl ?? fetch, CONNECTOR.callbackUrl);
    const app = express();
    app.use(express.json({ limit: BODY_LIMIT }));
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok' });
    });
    // Upstream Zendesk redirect target. No bearer (it's a browser redirect from Zendesk). Verify +
    // single-use-consume the anti-CSRF state, then hand the code back to the downstream (claude.ai)
    // redirect stashed at authorize time.
    app.get('/callback', (req, res) => {
        const code = req.query.code;
        const state = req.query.state;
        if (typeof code !== 'string' || typeof state !== 'string') {
            res.status(400).end('Missing code or state.');
            return;
        }
        let pending;
        try {
            pending = issued.consumePendingRedirect(state);
        }
        catch (e) {
            log({ msg: `oauth callback rejected: ${describeAuthError(e)}`, outcome: '403' });
            res.status(403).end('OAuth state mismatch or expired.');
            return;
        }
        const target = new URL(pending.redirectUri);
        target.searchParams.set('code', code);
        target.searchParams.set('state', state);
        res.redirect(target.toString());
    });
    app.use(mcpAuthRouter({
        provider,
        issuerUrl: new URL(CONNECTOR.issuerUrl),
        scopesSupported: config.scopes,
        resourceServerUrl: new URL(CONNECTOR.resourceUrl),
    }));
    const bearer = requireBearerAuth({ verifier: provider });
    app.post('/mcp', bearer, (req, res) => sessions.handlePost(req, res).catch((e) => fail(res, e)));
    app.get('/mcp', bearer, (req, res) => sessions.handleGet(req, res).catch((e) => fail(res, e)));
    app.delete('/mcp', bearer, (req, res) => sessions.handleDelete(req, res).catch((e) => fail(res, e)));
    return { app, provider, issued, resolver };
}
// Surface a 400 without ever logging the request body (REQ-1 negative: no body content in logs).
// The logged line uses the actionable auth/session copy, never a stack trace.
function fail(res, err) {
    // A missing/invalid identity is a re-auth signal (401); any other request error stays a fail-closed 400.
    const status = err instanceof InvalidTokenError ? 401 : 400;
    log({ msg: `mcp request error: ${describeAuthError(err)}`, outcome: String(status) });
    if (!res.headersSent)
        res.status(status).end();
}
