import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuthManager } from './auth/auth-manager.js';
import { TokenStore } from './auth/token-store.js';
import {
  callbackPortOrDefault,
  dataDirOf,
  DEFAULT_SCOPES,
  resolveAuthConfig,
  stripPlaceholders,
  type ResolvedAuthConfig,
} from './auth/config.js';
import {
  readKeychainConfig,
  resolveTokenStoreKey,
  runSecurity,
  writeKeychainConfig,
  type RunSecurity,
} from './auth/store-key.js';
import type { OAuthConfig } from './auth/oauth-flow.js';
import { warnConfig } from './util/warn-config.js';
import { errorCode } from './util/error-code.js';
import { RateLimiter } from './client/rate-limiter.js';
import { ZendeskHttpClient } from './client/http-client.js';
import { ResponseCache, type CacheStore } from './client/cache.js';
import type { SecurityLevel } from './security/screen.js';
import type { TokenProvider } from './client/token-provider.js';
import type { ToolContext } from './register/context.js';
import { registerAuthTools } from './register/auth.js';
import { registerDiagnosticsTool } from './register/diagnostics.js';
import { runLogin, type LoginDeps, type SetupDeps } from './tools/login.js';
import { registerCoreTools } from './register/core.js';
import { registerTicketTools } from './register/tickets.js';
import { registerSearchTools } from './register/search.js';
import { registerDirectoryTools } from './register/directory.js';
import { registerBusinessRulesTools } from './register/business-rules.js';
import { registerGuideTools } from './register/guide.js';
import { registerAnalyticsTools } from './register/analytics.js';
import { registerPrompts } from './register/prompts.js';
import { parseReportConfig } from './tools/analytics/business-hours.js';
import { argv } from 'node:process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

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
// to prevent. Absent stays 'standard', and since #68 that is not a mirror of a declared default but the
// shipped behaviour itself: .claude-plugin/plugin.json declares no security_level at all and the
// manifest.json default belongs to the retired MCPB dialog, so 'standard' IS the level the installed
// plugin runs at (owner decision on #59, 2026-10-06).
export const SECURITY_LEVELS: readonly SecurityLevel[] = ['strict', 'standard', 'off'];

function parseSecurityLevel(raw: string | undefined): SecurityLevel {
  const value = raw?.trim().toLowerCase();
  // Absence was the one resolution with no symptom at all, and it was silent in the dangerous
  // direction (#93 gap B): an operator who believed they had configured `strict` got `standard` and
  // nothing anywhere said so. In the installed plugin absence IS every start, and once per opened
  // session on the remote path.
  if (!value) {
    warnConfig(
      'ZENDESK_SECURITY_LEVEL is not set — injection screening runs at standard, the shipped level. ' +
        'The installed plugin declares no configuration field for it, so only a hand-started server ' +
        `or the remote connector reads this variable (${SECURITY_LEVELS.join(' | ')}; README, Security).`,
    );
    return 'standard';
  }
  if ((SECURITY_LEVELS as readonly string[]).includes(value)) return value as SecurityLevel;
  // JSON.stringify, not interpolation: it supplies the quotes AND escapes the breaks, so a value
  // like 'str\nict' can no longer forge a second line on the channel that reports it.
  warnConfig(
    `ZENDESK_SECURITY_LEVEL ${JSON.stringify(raw)} is not one of ${SECURITY_LEVELS.join(' | ')} \u2014 using ` +
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
    `ZENDESK_MARKDOWN_CONVERSION "${raw}" is not true | false \u2014 using true, the shipped ` +
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

function resolveOrDegrade(env: NodeJS.ProcessEnv, security: RunSecurity): AuthResolution {
  try {
    // The spread READS tokenStoreKey, which is where the Keychain is actually reached — deliberately
    // inside this try, so a key source that cannot answer (another platform, a locked keychain)
    // degrades with its message like any other incomplete configuration instead of killing the server.
    return { ok: true, ...resolveAuthConfig(env, security) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // The port is validated AFTER the subdomain, so `reason` is almost never about it — and a port nobody
    // mentions is a redirect URL the person registers wrong. Named here, where every tool answer carries it.
    const { problem } = callbackPortOrDefault(env);
    // Same precedence as resolveAuthConfig, over the same seam rather than a setting: where
    // ZENDESK_DATA_DIR is set the cache and the token store stay in that directory even while the
    // configuration is incomplete — but a relative one is dropped here rather than honoured, since
    // it is why we may be degrading.
    const dataDir = dataDirOf(env);
    return {
      ok: false,
      // Points at the setup page, which is what exists now: the Claude Code plugin has no settings
      // dialog any more (#68 removed its user_config, the host bridge does not support one), and on a
      // platform without a Keychain the environment is the only way in (#69). The MCPB extension still
      // HAS the dialog, so it is named last rather than first.
      reason:
        `${reason}${problem ? ` ${problem}` : ''} Call the zendesk_login tool: on macOS it answers with a local setup page that ` +
        'collects the subdomain, client id and client secret. Otherwise pass them in the environment ' +
        '(ZENDESK_SUBDOMAIN, ZENDESK_OAUTH_CLIENT_ID, ZENDESK_OAUTH_CLIENT_SECRET), or, in the Desktop ' +
        'Extension, fill the configuration dialog under Settings \u2192 Extensions \u2192 Zendesk.',
      dataDir,
      tokensPath: join(dataDir, 'tokens.enc'),
    };
  }
}

// Opening the cache can throw (EACCES/ENOSPC/ENOTDIR — the dir is created AND checked usable);
// tokens share the dir, so degrade like a bad config.
function openCacheOrDegrade(auth: AuthResolution): { auth: AuthResolution; cache: CacheStore; cacheOk: boolean } {
  try {
    return { auth, cache: new ResponseCache(join(auth.dataDir, 'cache')), cacheOk: true };
  } catch (err) {
    const code = errorCode(err);
    const problem =
      `The extension's data directory cannot be used (${code}), so responses cannot be cached and ` +
      `tokens cannot be stored. Make sure it is a writable directory with free space, then reload the extension.`;
    const reason = auth.ok ? problem : `${auth.reason.replace(/,? then reload the extension\.$/, '.')} ${problem}`;
    const fail = (): never => {
      throw new Error(reason);
    };
    const cache: CacheStore = { save: fail, load: fail };
    return { auth: { ok: false, reason, dataDir: auth.dataDir, tokensPath: auth.tokensPath }, cache, cacheOk: false };
  }
}

// The configuration an incomplete start carries. The subdomain and the client id are genuinely absent
// — that is what the first-run page collects — but the PORT and the SCOPES are not: the page has to
// name the redirect URL the customer must register, and the authorization it continues into has to ask
// for the same scopes every other start asks for.
const noOAuthConfig = (callbackPort: number) => ({ subdomain: '', clientId: '', callbackPort, scopes: DEFAULT_SCOPES });

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
  cache?: CacheStore;
  // Test seam only: a mocked Zendesk fetch for the per-session http client. Default (stdio and
  // prod) leaves it unset → the client uses the global fetch, byte-identical to today.
  fetchImpl?: typeof fetch;
  // The ONE seam for everything that reaches the macOS Keychain — the token-store key and the three
  // OAuth values alike. A test seam, because a suite must not depend on a real login keychain: CI runs
  // on Linux, where that source does not exist at all, and on a developer's machine it holds their own
  // configuration. Unset → the real `security` runner.
  security?: RunSecurity;
}

// Build and fully wire the MCP server (auth, rate buckets, cache, ctx, all tool registration)
// without connecting a transport — so the wiring is importable and testable. Reads env from the
// argument (defaults to process.env) so a test can inject a fixture environment.
export function createServer(rawEnv: NodeJS.ProcessEnv = process.env, deps: ServerDeps = {}): CreatedServer {
  // Drop unsubstituted ${user_config.*} placeholders once, up front, so every downstream default
  // (security level, markdown flag, report config) sees "absent" rather than a literal placeholder.
  const env = stripPlaceholders(rawEnv);
  const security = deps.security ?? runSecurity;
  const resolved = resolveOrDegrade(env, security);
  const { auth, cache, cacheOk } = deps.cache
    ? { auth: resolved, cache: deps.cache, cacheOk: true }
    : openCacheOrDegrade(resolved);
  const { tokensPath } = auth;
  const securityLevel = parseSecurityLevel(env.ZENDESK_SECURITY_LEVEL);
  const markdownDefault = parseMarkdownDefault(env.ZENDESK_MARKDOWN_CONVERSION);

  // The port is resolved on its OWN, because it is independent of everything else and the setup page has
  // to NAME it: resolveAuthConfig validates the subdomain first and throws there, so a degraded start
  // used to fall back to 8976 — and the only person who sets a different port does so because 8976 is
  // taken, which is both the port the page would have told them to register and the one it could not bind.
  const callbackPort = auth.ok ? auth.config.callbackPort : callbackPortOrDefault(env).port;

  // Can a first-run setup be offered? Only where what it produces can be stored.
  //
  // Asked for a CONFIGURED install too, and that is the point: a stored configuration can be complete
  // and WRONG — a subdomain typed `acmee` resolves, so the plugin never degrades — and setup=true is then
  // the only way back to the page. Where the configuration resolved, the Keychain has already answered
  // with the token-store key (the spread in resolveOrDegrade read it), so the question is settled and
  // nothing is read again. Where it did not, both halves are asked, because macOS ACLs are per item: a
  // page offered over values we cannot even read would collect three and `-U` over what is there.
  let setupKey: string | undefined;
  if (auth.ok) {
    setupKey = auth.tokenStoreKey;
  } else if (cacheOk) {
    try {
      readKeychainConfig(security);
      setupKey = resolveTokenStoreKey(security);
    } catch {
      // Nowhere to store an answer. `auth.reason` already says why.
    }
  }
  // The writer takes the SAME runner the reads took: one seam for everything that reaches the Keychain,
  // or an injected one is not an injected one.
  const setup: SetupDeps | undefined = setupKey
    ? { writeConfig: (values) => writeKeychainConfig(values, security) }
    : undefined;

  // Only the local (stdio/extension) path can receive the localhost OAuth callback; an injected
  // TokenProvider means the remote bridge already owns authorization. Kept out of ctx so the OAuth
  // client secret inside LoginDeps stays out of reach of the other 64 registrars.
  const login: LoginDeps | undefined = deps.authManager
    ? undefined
    : auth.ok
      ? { config: auth.config, tokensPath, tokenStoreKey: auth.tokenStoreKey, setup }
      : {
          config: noOAuthConfig(callbackPort),
          tokensPath,
          tokenStoreKey: setupKey ?? '',
          configError: auth.reason,
          setup,
        };

  // The first tool call without usable credentials starts the authorization itself and answers with the
  // URL. Through runLogin, so it shares the ONE queue, the ONE flow and the ONE listener with
  // zendesk_login — two concurrent tool calls cannot open two of either. Nothing opens a browser: the
  // person clicks the URL on their own device (decision D3).
  const startLogin = login && (() => runLogin(login));

  // The configuration can arrive AFTER this server started: the setup page stores it mid-session. What
  // the page hands back here is the configuration itself, so nothing is read a second time — and both
  // halves that were frozen at startup are replaced, the token boundary AND the Zendesk host. Without
  // the second one a healed token boundary would send every request to https://.zendesk.com.
  let healed: AuthManager | undefined;
  let healedSubdomain = '';
  if (login && setup && setupKey) {
    setup.onConfigured = (config) => {
      healedSubdomain = config.subdomain;
      healed = new AuthManager(new TokenStore(tokensPath, setupKey), config, undefined, startLogin);
      // The login tool holds the same object, and it answered "not set up" from these two FIELDS even
      // after a healed session had served a Zendesk request: the degraded reason outlived the reason for
      // it. Cleared together, so a later login authorizes against the tenant that was just configured
      // rather than against the empty one this process started with.
      login.config = config;
      login.configError = null;
    };
  }

  const authManager: TokenProvider =
    (cacheOk ? deps.authManager : undefined) ??
    (auth.ok
      ? new AuthManager(new TokenStore(tokensPath, auth.tokenStoreKey), auth.config, undefined, startLogin)
      : // Stands in for AuthManager while the configuration is incomplete: every Zendesk request fails
        // at the token boundary with the actionable message instead of reaching the network — until the
        // setup page supplies one, from which moment this delegates to the real thing.
        { getAccessToken: () => (healed ? healed.getAccessToken() : Promise.reject(new Error(auth.reason))) });
  const rateLimiter = deps.rateLimiter ?? new RateLimiter({ requestsPerMinute: DEFAULT_RATE_LIMIT_RPM });
  const incrementalRateLimiter = deps.incrementalRateLimiter ?? new RateLimiter({ requestsPerMinute: INCREMENTAL_RATE_LIMIT_RPM });
  // A function, not a string, for the degraded path only: the host is unknown until setup supplies it.
  const subdomain = auth.ok ? auth.config.subdomain : () => healedSubdomain;
  const httpClient = new ZendeskHttpClient({ subdomain, authManager, rateLimiter, incrementalRateLimiter, fetchImpl: deps.fetchImpl });

  const server = new McpServer({ name: 'zendesk', version: '1.1.0' });
  const ctx: ToolContext = {
    httpClient,
    cache,
    securityLevel,
    markdownDefault,
    reportConfig: parseReportConfig(env),
  };
  registerAuthTools(server, login);
  // Local path only, on the same condition as the login tool: on the remote bridge the hostname and
  // the loopback bind belong to the operator's machine, not to the user who asked.
  //
  // rawEnv, not the stripped copy: the question it answers is whether the HOST substituted the two
  // variables, and stripPlaceholders has already deleted the evidence from `env`.
  if (login) {
    registerDiagnosticsTool(server, { rawEnv, callbackPort });
  }
  registerCoreTools(server, ctx);
  registerTicketTools(server, ctx);
  registerSearchTools(server, ctx);
  registerDirectoryTools(server, ctx);
  registerBusinessRulesTools(server, ctx);
  registerGuideTools(server, ctx);
  registerAnalyticsTools(server, ctx);
  registerPrompts(server);

  return { server, ctx, rateLimiter, incrementalRateLimiter };
}

// Connect stdio only when run as the process entrypoint (node dist/server.js), so importing this
// module for tests does not attempt to open a transport.
//
// Compared by file IDENTITY, not by name (#63): Node resolves symlinks in an ES module's
// import.meta.url but leaves argv[1] as the host spelled it, so a plugin root reached through a
// symlink made a name comparison unequal — the module loaded, no transport was connected, and the
// process exited 0 with an empty stderr. dev+ino is what the filesystem itself calls identity, so
// no spelling can split one file into two. An argv[1] that names no file answers "not the
// entrypoint", and { throwIfNoEntry: false } draws exactly that line: measured ENOENT and ENOTDIR
// return undefined while ELOOP and EACCES still throw, so a stat that fails for any other reason
// leaves a stack on stderr instead of the silent exit 0 with no transport that #63 forbids.
function startedAsEntrypoint(): boolean {
  const started = argv[1] ? statSync(argv[1], { throwIfNoEntry: false }) : undefined;
  if (!started) return false;
  const self = statSync(fileURLToPath(import.meta.url));
  return started.dev === self.dev && started.ino === self.ino;
}

if (startedAsEntrypoint()) {
  const { server } = createServer();
  await server.connect(new StdioServerTransport());
}
