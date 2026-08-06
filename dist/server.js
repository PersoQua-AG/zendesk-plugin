import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuthManager } from './auth/auth-manager.js';
import { TokenStore } from './auth/token-store.js';
import { resolveAuthConfig } from './auth/config.js';
import { RateLimiter } from './client/rate-limiter.js';
import { ZendeskHttpClient } from './client/http-client.js';
import { ResponseCache } from './client/cache.js';
import { registerCoreTools } from './register/core.js';
import { registerTicketTools } from './register/tickets.js';
import { registerSearchTools } from './register/search.js';
import { registerDirectoryTools } from './register/directory.js';
import { registerBusinessRulesTools } from './register/business-rules.js';
import { registerGuideTools } from './register/guide.js';
import { registerAnalyticsTools } from './register/analytics.js';
import { parseReportConfig } from './tools/analytics/business-hours.js';
import { argv } from 'node:process';
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
// Build and fully wire the MCP server (auth, rate buckets, cache, ctx, all tool registration)
// without connecting a transport — so the wiring is importable and testable. Reads env from the
// argument (defaults to process.env) so a test can inject a fixture environment.
export function createServer(env = process.env, deps = {}) {
    const { config: oauthConfig, dataDir, tokensPath } = resolveAuthConfig(env);
    const { subdomain, clientSecret } = oauthConfig;
    const securityLevel = parseSecurityLevel(env.ZENDESK_SECURITY_LEVEL);
    const markdownDefault = parseMarkdownDefault(env.ZENDESK_MARKDOWN_CONVERSION);
    const authManager = deps.authManager ?? new AuthManager(new TokenStore(tokensPath, clientSecret), oauthConfig);
    const rateLimiter = deps.rateLimiter ?? new RateLimiter({ requestsPerMinute: DEFAULT_RATE_LIMIT_RPM });
    const incrementalRateLimiter = deps.incrementalRateLimiter ?? new RateLimiter({ requestsPerMinute: INCREMENTAL_RATE_LIMIT_RPM });
    const httpClient = new ZendeskHttpClient({ subdomain, authManager, rateLimiter, incrementalRateLimiter, fetchImpl: deps.fetchImpl });
    const cache = deps.cache ?? new ResponseCache(`${dataDir}/cache`);
    const server = new McpServer({ name: 'zendesk', version: '0.1.0' });
    const ctx = { httpClient, cache, securityLevel, markdownDefault, reportConfig: parseReportConfig(env) };
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
