import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuthManager } from './auth/auth-manager.js';
import { TokenStore } from './auth/token-store.js';
import { defaultDataDir, resolveAuthConfig, stripPlaceholders, type ResolvedAuthConfig } from './auth/config.js';
import { RateLimiter } from './client/rate-limiter.js';
import { ZendeskHttpClient } from './client/http-client.js';
import { ResponseCache } from './client/cache.js';
import type { SecurityLevel } from './security/screen.js';
import type { TokenProvider } from './client/token-provider.js';
import type { ToolContext } from './register/context.js';
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

function parseSecurityLevel(raw: string | undefined): SecurityLevel {
  return raw === 'strict' || raw === 'off' ? raw : 'standard';
}

// Global Markdown→HTML default (PRD §8). A per-call `markdown` argument overrides it.
function parseMarkdownDefault(raw: string | undefined): boolean {
  return raw !== 'false';
}

// A Desktop Extension host launches the server BEFORE the user has filled in the configuration
// dialog, and again after every edit. Throwing there leaves a dead extension with no explanation,
// so the stdio server starts anyway and every tool answers with the field to fill in. Kept local to
// server.ts on purpose: bin/authorize.ts and the remote path still want resolveAuthConfig to throw.
// A union rather than a ResolvedAuthConfig filled in with blanks: with an incomplete configuration
// there IS no OAuth config, so the degraded case simply does not carry one and the invalid state
// (subdomain '', callbackPort 0) is not representable.
type AuthResolution =
  | ({ ok: true } & ResolvedAuthConfig)
  | { ok: false; reason: string; dataDir: string; tokensPath: string };

function resolveOrDegrade(env: NodeJS.ProcessEnv): AuthResolution {
  try {
    return { ok: true, ...resolveAuthConfig(env) };
  } catch (err) {
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

export interface CreatedServer {
  server: McpServer;
  ctx: ToolContext;
  rateLimiter: RateLimiter;
  incrementalRateLimiter: RateLimiter;
}

// Optional injection seam (M9): the remote path supplies a per-user TokenProvider, shared
// account-wide rate buckets, and a per-user cache. Every field defaults to today's stdio
// single-identity construction, so createServer() with no deps is byte-identical.
export interface ServerDeps {
  authManager?: TokenProvider;
  rateLimiter?: RateLimiter;
  incrementalRateLimiter?: RateLimiter;
  cache?: ResponseCache;
  // Test seam only: a mocked Zendesk fetch for the per-session http client. Default (stdio and
  // prod) leaves it unset → the client uses the global fetch, byte-identical to today.
  fetchImpl?: typeof fetch;
}

// Build and fully wire the MCP server (auth, rate buckets, cache, ctx, all tool registration)
// without connecting a transport — so the wiring is importable and testable. Reads env from the
// argument (defaults to process.env) so a test can inject a fixture environment.
export function createServer(rawEnv: NodeJS.ProcessEnv = process.env, deps: ServerDeps = {}): CreatedServer {
  // Drop unsubstituted ${user_config.*} placeholders once, up front, so every downstream default
  // (security level, markdown flag, report config) sees "absent" rather than a literal placeholder.
  const env = stripPlaceholders(rawEnv);
  const auth = resolveOrDegrade(env);
  const { dataDir, tokensPath } = auth;
  const securityLevel = parseSecurityLevel(env.ZENDESK_SECURITY_LEVEL);
  const markdownDefault = parseMarkdownDefault(env.ZENDESK_MARKDOWN_CONVERSION);

  const authManager: TokenProvider =
    deps.authManager ??
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
  const ctx: ToolContext = {
    httpClient,
    cache,
    securityLevel,
    markdownDefault,
    reportConfig: parseReportConfig(env),
  };
  // Only the local (stdio/extension) path can receive the localhost OAuth callback; an injected
  // TokenProvider means the remote bridge already owns authorization. Kept out of ctx so the OAuth
  // client secret inside LoginDeps stays out of reach of the other 64 registrars.
  registerAuthTools(
    server,
    deps.authManager
      ? undefined
      : auth.ok
        ? { config: auth.config, tokensPath }
        : { config: NO_OAUTH_CONFIG, tokensPath, configError: auth.reason },
  );
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
