import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuthManager } from './auth/auth-manager.js';
import { TokenStore } from './auth/token-store.js';
import { resolveAuthConfig } from './auth/config.js';
import { RateLimiter } from './client/rate-limiter.js';
import { ZendeskHttpClient } from './client/http-client.js';
import { ResponseCache } from './client/cache.js';
import type { SecurityLevel } from './security/screen.js';
import type { ToolContext } from './register/context.js';
import { registerCoreTools } from './register/core.js';
import { registerTicketTools } from './register/tickets.js';
import { registerSearchTools } from './register/search.js';
import { registerDirectoryTools } from './register/directory.js';
import { registerBusinessRulesTools } from './register/business-rules.js';
import { registerGuideTools } from './register/guide.js';
import { registerAnalyticsTools } from './register/analytics.js';
import { parseReportConfig } from './tools/analytics/business-hours.js';

function parseSecurityLevel(raw: string | undefined): SecurityLevel {
  return raw === 'strict' || raw === 'off' ? raw : 'standard';
}

// Global Markdown→HTML default (PRD §8). A per-call `markdown` argument overrides it.
function parseMarkdownDefault(raw: string | undefined): boolean {
  return raw !== 'false';
}

const { config: oauthConfig, dataDir, tokensPath } = resolveAuthConfig(process.env);
const { subdomain, clientSecret } = oauthConfig;
const securityLevel = parseSecurityLevel(process.env.ZENDESK_SECURITY_LEVEL);
const markdownDefault = parseMarkdownDefault(process.env.ZENDESK_MARKDOWN_CONVERSION);

const tokenStore = new TokenStore(tokensPath, clientSecret);
const authManager = new AuthManager(tokenStore, oauthConfig);
const rateLimiter = new RateLimiter({ requestsPerMinute: 400 });
// Incremental export is special-cased to 10 req/min globally (PRD §5 infra 1).
const incrementalRateLimiter = new RateLimiter({ requestsPerMinute: 10 });
const httpClient = new ZendeskHttpClient({ subdomain, authManager, rateLimiter, incrementalRateLimiter });
const cache = new ResponseCache(`${dataDir}/cache`);

const server = new McpServer({ name: 'zendesk', version: '0.1.0' });

const ctx: ToolContext = { httpClient, cache, securityLevel, markdownDefault, reportConfig: parseReportConfig(process.env) };
registerCoreTools(server, ctx);
registerTicketTools(server, ctx);
registerSearchTools(server, ctx);
registerDirectoryTools(server, ctx);
registerBusinessRulesTools(server, ctx);
registerGuideTools(server, ctx);
registerAnalyticsTools(server, ctx);

const transport = new StdioServerTransport();
await server.connect(transport);
