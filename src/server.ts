import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuthManager } from './auth/auth-manager.js';
import { TokenStore } from './auth/token-store.js';
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseSecurityLevel(raw: string | undefined): SecurityLevel {
  return raw === 'strict' || raw === 'off' ? raw : 'standard';
}

// Global Markdown→HTML default (PRD §8). A per-call `markdown` argument overrides it.
function parseMarkdownDefault(raw: string | undefined): boolean {
  return raw !== 'false';
}

const subdomain = requireEnv('ZENDESK_SUBDOMAIN');
const clientId = requireEnv('ZENDESK_OAUTH_CLIENT_ID');
const clientSecret = requireEnv('ZENDESK_OAUTH_CLIENT_SECRET');
const dataDir = process.env.CLAUDE_PLUGIN_DATA ?? '.zendesk-plugin-data';
const securityLevel = parseSecurityLevel(process.env.ZENDESK_SECURITY_LEVEL);
const markdownDefault = parseMarkdownDefault(process.env.ZENDESK_MARKDOWN_CONVERSION);

const tokenStore = new TokenStore(`${dataDir}/tokens.enc`, clientSecret);
const authManager = new AuthManager(tokenStore, {
  subdomain,
  clientId,
  clientSecret,
  callbackPort: Number(process.env.ZENDESK_OAUTH_CALLBACK_PORT ?? '8976'),
  scopes: ['read', 'write'],
});
const rateLimiter = new RateLimiter({ requestsPerMinute: 400 });
const httpClient = new ZendeskHttpClient({ subdomain, authManager, rateLimiter });
const cache = new ResponseCache(`${dataDir}/cache`);

const server = new McpServer({ name: 'zendesk', version: '0.1.0' });

const ctx: ToolContext = { httpClient, cache, securityLevel, markdownDefault };
registerCoreTools(server, ctx);
registerTicketTools(server, ctx);
registerSearchTools(server, ctx);
registerDirectoryTools(server, ctx);
registerBusinessRulesTools(server, ctx);

const transport = new StdioServerTransport();
await server.connect(transport);
