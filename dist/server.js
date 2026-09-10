import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuthManager } from './auth/auth-manager.js';
import { TokenStore } from './auth/token-store.js';
import { defaultDataDir, resolveAuthConfig, stripPlaceholders } from './auth/config.js';
import { RateLimiter } from './client/rate-limiter.js';
import { ZendeskHttpClient } from './client/http-client.js';
import { ResponseCache } from './client/cache.js';
import { registerAuthTools } from './register/auth.js';
import { registerCoreTools } from './register/core.js';
import { registerTicketTools } from './register/tickets.js';
import { registerSearchTools } from './register/search.js';
import { registerDirectoryTools } from './register/directory.js';
import { registerBusinessRulesTools } from './register/business-rules.js';
import { registerGuideTools } from './register/guide.js';
import { registerAnalyticsTools } from './register/analytics.js';
import { parseReportConfig } from './tools/analytics/business-hours.js';
import { argv } from 'node:process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Account-wide rate buckets (PRD §5 infra 1): everything shares 400/min; incremental export is
// special-cased to 10/min.
export const DEFAULT_RATE_LIMIT_RPM = 400;
export const INCREMENTAL_RATE_LIMIT_RPM = 10;
function parseSecurityLevel(raw) {
    return raw === 'strict' || raw === 'off' ? raw : 'standard';
}
// Global Markdown→HTML default (PRD §8). A per-call `markdown` argument overrides it.
function parseMarkdownDefault(raw) {
    return raw !== 'false';
}
function resolveOrDegrade(env) {
    try {
        return { ok: true, ...resolveAuthConfig(env) };
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Same precedence as resolveAuthConfig: an explicit CLAUDE_PLUGIN_DATA wins, so the cache and
        // the token store stay in the configured directory even while the configuration is incomplete.
        const dataDir = env.CLAUDE_PLUGIN_DATA || defaultDataDir(env);
        return {
            ok: false,
            reason: `${reason} Open Settings \u2192 Extensions \u2192 Zendesk, complete the configuration, then reload the extension.`,
            dataDir,
            tokensPath: join(dataDir, 'tokens.enc'),
        };
    }
}
// runLogin answers with configError before it reads anything else, so these values are never used;
// they only satisfy the LoginDeps shape while the configuration is incomplete.
const NO_OAUTH_CONFIG = { subdomain: '', clientId: '', clientSecret: '', callbackPort: 0, scopes: [] };
// Build and fully wire the MCP server (auth, rate buckets, cache, ctx, all tool registration)
// without connecting a transport — so the wiring is importable and testable. Reads env from the
// argument (defaults to process.env) so a test can inject a fixture environment.
export function createServer(rawEnv = process.env, deps = {}) {
    // Drop unsubstituted ${user_config.*} placeholders once, up front, so every downstream default
    // (security level, markdown flag, report config) sees "absent" rather than a literal placeholder.
    const env = stripPlaceholders(rawEnv);
    const auth = resolveOrDegrade(env);
    const { dataDir, tokensPath } = auth;
    const securityLevel = parseSecurityLevel(env.ZENDESK_SECURITY_LEVEL);
    const markdownDefault = parseMarkdownDefault(env.ZENDESK_MARKDOWN_CONVERSION);
    const authManager = deps.authManager ??
        (auth.ok
            ? new AuthManager(new TokenStore(tokensPath, auth.config.clientSecret), auth.config)
            : // Stands in for AuthManager while the configuration is incomplete: every Zendesk request
                // fails at the token boundary with the actionable message instead of reaching the network.
                { getAccessToken: () => Promise.reject(new Error(auth.reason)) });
    const rateLimiter = deps.rateLimiter ?? new RateLimiter({ requestsPerMinute: DEFAULT_RATE_LIMIT_RPM });
    const incrementalRateLimiter = deps.incrementalRateLimiter ?? new RateLimiter({ requestsPerMinute: INCREMENTAL_RATE_LIMIT_RPM });
    const subdomain = auth.ok ? auth.config.subdomain : '';
    const httpClient = new ZendeskHttpClient({ subdomain, authManager, rateLimiter, incrementalRateLimiter, fetchImpl: deps.fetchImpl });
    const cache = deps.cache ?? new ResponseCache(join(dataDir, 'cache'));
    const server = new McpServer({ name: 'zendesk', version: '0.1.0' });
    const ctx = {
        httpClient,
        cache,
        securityLevel,
        markdownDefault,
        reportConfig: parseReportConfig(env),
    };
    // Only the local (stdio/extension) path can receive the localhost OAuth callback; an injected
    // TokenProvider means the remote bridge already owns authorization. Kept out of ctx so the OAuth
    // client secret inside LoginDeps stays out of reach of the other 64 registrars.
    registerAuthTools(server, deps.authManager
        ? undefined
        : auth.ok
            ? { config: auth.config, tokensPath }
            : { config: NO_OAUTH_CONFIG, tokensPath, configError: auth.reason });
    registerCoreTools(server, ctx);
    registerTicketTools(server, ctx);
    registerSearchTools(server, ctx);
    registerDirectoryTools(server, ctx);
    registerBusinessRulesTools(server, ctx);
    registerGuideTools(server, ctx);
    registerAnalyticsTools(server, ctx);
    return { server, ctx, rateLimiter, incrementalRateLimiter };
}
// Connect stdio only when run as the process entrypoint (node dist/server.js), so importing this
// module for tests does not attempt to open a transport.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
    const { server } = createServer();
    await server.connect(new StdioServerTransport());
}
