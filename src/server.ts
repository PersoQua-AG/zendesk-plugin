import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuthManager } from './auth/auth-manager.js';
import { TokenStore } from './auth/token-store.js';
import {
  defaultDataDir,
  resolveAuthConfig,
  stripPlaceholders,
  USER_CONFIG_FIELD_BY_ENV,
  type ResolvedAuthConfig,
} from './auth/config.js';
import { warnConfig } from './util/warn-config.js';
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

// An unrecognized value is never quietly downgraded. 'Strict', 'stict' and 'strict ' all used to
// land on 'standard' without a word, so an operator who configured stricter injection screening got
// weaker screening and had no symptom to notice — the one misconfiguration whose failure mode is
// that everything looks fine. Case and surrounding whitespace are copy-paste artifacts rather than
// opinions, so they are normalized away; anything still unrecognized warns AND resolves to the
// STRICTEST level, so an unreadable security setting can only ever err toward more screening.
//
// A warning rather than a thrown error, unlike the callback port, for two reasons. The port has no
// safe substitute (any other port breaks the redirect_uri the user registered with Zendesk), a
// security level does. And the port's throw is caught: resolveOrDegrade turns it into a server that
// still starts and names the field in every tool's answer, while a throw out of parseSecurityLevel
// would leave a dead extension with nothing to read — exactly the outcome resolveOrDegrade exists
// to prevent. Absent stays 'standard': that is the shipped default both manifests declare, not a typo.
export const SECURITY_LEVELS: readonly SecurityLevel[] = ['strict', 'standard', 'off'];

function parseSecurityLevel(raw: string | undefined): SecurityLevel {
  const value = raw?.trim().toLowerCase();
  if (!value) return 'standard';
  if ((SECURITY_LEVELS as readonly string[]).includes(value)) return value as SecurityLevel;
  warnConfig(
    `ZENDESK_SECURITY_LEVEL "${raw}" is not one of ${SECURITY_LEVELS.join(' | ')} (extension configuration ` +
      `field "${USER_CONFIG_FIELD_BY_ENV.ZENDESK_SECURITY_LEVEL}") \u2014 using ` +
      `strict, the strictest level, rather than silently screening less.`,
  );
  return 'strict';
}

// Global Markdown→HTML default (PRD §8). A per-call `markdown` argument overrides it.
//
// Same class of bug as the level above: `raw !== 'false'` made 'False' and 'false ' mean TRUE, so
// case and surrounding whitespace are normalized away here too. There is no fail-closed direction
// to fall to — converting when the user meant not to and the reverse are the same size of mistake,
// and both are visible in the ticket — so an unreadable value falls back to the value both
// manifests DECLARE (true) rather than to a guess at what was meant.
function parseMarkdownDefault(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return true;
  if (value === 'true' || value === 'false') return value === 'true';
  warnConfig(
    `ZENDESK_MARKDOWN_CONVERSION "${raw}" is not true | false (extension configuration field ` +
      `"${USER_CONFIG_FIELD_BY_ENV.ZENDESK_MARKDOWN_CONVERSION}") \u2014 using true, the shipped ` +
      `default, rather than reading it as a "no".`,
  );
  return true;
}

// A Desktop Extension host launches the server BEFORE the user has filled in the configuration
// dialog, and again after every edit. Throwing there leaves a dead extension with no explanation,
// so the stdio server starts anyway and every tool answers with the field to fill in. Kept local to
// server.ts on purpose: bin/authorize.ts and the remote path still want resolveAuthConfig to throw.
// A union rather than a ResolvedAuthConfig filled in with blanks: with an incomplete configuration
// there IS no OAuth config, so the degraded case simply does not carry one and the invalid state
// (subdomain '', callbackPort 0) is not representable. `reason` may also carry a storage error,
// because the token store shares the data directory with the cache.
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

// mkdir can throw (EACCES/ENOSPC/ENOTDIR); tokens share the dir, so degrade like a bad config.
function openCacheOrDegrade(auth: AuthResolution): { auth: AuthResolution; cache: ResponseCache; cacheOk: boolean } {
  try {
    return { auth, cache: new ResponseCache(join(auth.dataDir, 'cache')), cacheOk: true };
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : 'unknown error';
    const problem =
      `The extension's data directory cannot be used (${code}), so responses cannot be cached and ` +
      `tokens cannot be stored. Make sure it is a writable directory with free space, then reload the extension.`;
    const reason = auth.ok ? problem : `${auth.reason.replace(/,? then reload the extension\.$/, '.')} ${problem}`;
    const fail = (): never => {
      throw new Error(reason);
    };
    // ResponseCache is nominal (private fields); tools only call save/load.
    const stub = { save: fail, load: fail } satisfies Pick<ResponseCache, 'save' | 'load'>;
    const cache = stub as unknown as ResponseCache;
    return { auth: { ok: false, reason, dataDir: auth.dataDir, tokensPath: auth.tokensPath }, cache, cacheOk: false };
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
  const resolved = resolveOrDegrade(env);
  const { auth, cache, cacheOk } = deps.cache
    ? { auth: resolved, cache: deps.cache, cacheOk: true }
    : openCacheOrDegrade(resolved);
  const { tokensPath } = auth;
  const securityLevel = parseSecurityLevel(env.ZENDESK_SECURITY_LEVEL);
  const markdownDefault = parseMarkdownDefault(env.ZENDESK_MARKDOWN_CONVERSION);

  const authManager: TokenProvider =
    (cacheOk ? deps.authManager : undefined) ??
    (auth.ok
      ? new AuthManager(new TokenStore(tokensPath, auth.config.clientSecret), auth.config)
      : // Stands in for AuthManager while the configuration is incomplete: every Zendesk request
        // fails at the token boundary with the actionable message instead of reaching the network.
        { getAccessToken: () => Promise.reject(new Error(auth.reason)) });
  const rateLimiter = deps.rateLimiter ?? new RateLimiter({ requestsPerMinute: DEFAULT_RATE_LIMIT_RPM });
  const incrementalRateLimiter = deps.incrementalRateLimiter ?? new RateLimiter({ requestsPerMinute: INCREMENTAL_RATE_LIMIT_RPM });
  const subdomain = auth.ok ? auth.config.subdomain : '';
  const httpClient = new ZendeskHttpClient({ subdomain, authManager, rateLimiter, incrementalRateLimiter, fetchImpl: deps.fetchImpl });

  const server = new McpServer({ name: 'zendesk', version: '1.0.0' });
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
