import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuthManager } from './auth/auth-manager.js';
import { TokenStore } from './auth/token-store.js';
import { dataDirOf, DEFAULT_CALLBACK_PORT, DEFAULT_SCOPES, resolveAuthConfig, stripPlaceholders, USER_CONFIG_FIELD_BY_ENV, } from './auth/config.js';
import { readKeychainConfig, resolveTokenStoreKey, runSecurity } from './auth/store-key.js';
import { warnConfig } from './util/warn-config.js';
import { RateLimiter } from './client/rate-limiter.js';
import { ZendeskHttpClient } from './client/http-client.js';
import { ResponseCache } from './client/cache.js';
import { registerAuthTools } from './register/auth.js';
import { registerDiagnosticsTool } from './register/diagnostics.js';
import { runLogin } from './tools/login.js';
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
export const SECURITY_LEVELS = ['strict', 'standard', 'off'];
function parseSecurityLevel(raw) {
    const value = raw?.trim().toLowerCase();
    if (!value)
        return 'standard';
    if (SECURITY_LEVELS.includes(value))
        return value;
    warnConfig(`ZENDESK_SECURITY_LEVEL "${raw}" is not one of ${SECURITY_LEVELS.join(' | ')} (extension configuration ` +
        `field "${USER_CONFIG_FIELD_BY_ENV.ZENDESK_SECURITY_LEVEL}") \u2014 using ` +
        `strict, the strictest level, rather than silently screening less.`);
    return 'strict';
}
// Global Markdown→HTML default (PRD §8). A per-call `markdown` argument overrides it.
//
// Same class of bug as the level above: `raw !== 'false'` made 'False' and 'false ' mean TRUE, so
// case and surrounding whitespace are normalized away here too. There is no fail-closed direction
// to fall to — converting when the user meant not to and the reverse are the same size of mistake,
// and both are visible in the ticket — so an unreadable value falls back to the value both
// manifests DECLARE (true) rather than to a guess at what was meant.
function parseMarkdownDefault(raw) {
    const value = raw?.trim().toLowerCase();
    if (!value)
        return true;
    if (value === 'true' || value === 'false')
        return value === 'true';
    warnConfig(`ZENDESK_MARKDOWN_CONVERSION "${raw}" is not true | false (extension configuration field ` +
        `"${USER_CONFIG_FIELD_BY_ENV.ZENDESK_MARKDOWN_CONVERSION}") \u2014 using true, the shipped ` +
        `default, rather than reading it as a "no".`);
    return true;
}
function resolveOrDegrade(env, security) {
    try {
        // The spread READS tokenStoreKey, which is where the Keychain is actually reached — deliberately
        // inside this try, so a key source that cannot answer (another platform, a locked keychain)
        // degrades with its message like any other incomplete configuration instead of killing the server.
        return { ok: true, ...resolveAuthConfig(env, security) };
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Same precedence as resolveAuthConfig: an explicit CLAUDE_PLUGIN_DATA wins, so the cache and
        // the token store stay in the configured directory even while the configuration is incomplete —
        // but a relative one is dropped here rather than honoured, since it is why we may be degrading.
        const dataDir = dataDirOf(env);
        return {
            ok: false,
            // Points at the setup page, which is what exists now: the Claude Code plugin has no settings
            // dialog any more (#68 removed its user_config, the host bridge does not support one), and on a
            // platform without a Keychain the environment is the only way in (#69). The MCPB extension still
            // HAS the dialog, so it is named last rather than first.
            reason: `${reason} Call the zendesk_login tool: on macOS it answers with a local setup page that ` +
                'collects the subdomain, client id and client secret. Otherwise pass them in the environment ' +
                '(ZENDESK_SUBDOMAIN, ZENDESK_OAUTH_CLIENT_ID, ZENDESK_OAUTH_CLIENT_SECRET), or, in the Desktop ' +
                'Extension, fill the configuration dialog under Settings \u2192 Extensions \u2192 Zendesk.',
            dataDir,
            tokensPath: join(dataDir, 'tokens.enc'),
        };
    }
}
// mkdir can throw (EACCES/ENOSPC/ENOTDIR); tokens share the dir, so degrade like a bad config.
function openCacheOrDegrade(auth) {
    try {
        return { auth, cache: new ResponseCache(join(auth.dataDir, 'cache')), cacheOk: true };
    }
    catch (err) {
        const code = err instanceof Error && 'code' in err ? String(err.code) : 'unknown error';
        const problem = `The extension's data directory cannot be used (${code}), so responses cannot be cached and ` +
            `tokens cannot be stored. Make sure it is a writable directory with free space, then reload the extension.`;
        const reason = auth.ok ? problem : `${auth.reason.replace(/,? then reload the extension\.$/, '.')} ${problem}`;
        const fail = () => {
            throw new Error(reason);
        };
        // ResponseCache is nominal (private fields); tools only call save/load.
        const stub = { save: fail, load: fail };
        const cache = stub;
        return { auth: { ok: false, reason, dataDir: auth.dataDir, tokensPath: auth.tokensPath }, cache, cacheOk: false };
    }
}
// The configuration an incomplete start carries. The subdomain and the client id are genuinely absent
// — that is what the first-run page collects — but the PORT and the SCOPES are not: the page has to
// name the redirect URL the customer must register, and the authorization it continues into has to ask
// for the same scopes every other start asks for.
const noOAuthConfig = (callbackPort) => ({ subdomain: '', clientId: '', callbackPort, scopes: DEFAULT_SCOPES });
// Build and fully wire the MCP server (auth, rate buckets, cache, ctx, all tool registration)
// without connecting a transport — so the wiring is importable and testable. Reads env from the
// argument (defaults to process.env) so a test can inject a fixture environment.
export function createServer(rawEnv = process.env, deps = {}) {
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
    const callbackPort = auth.ok ? auth.config.callbackPort : DEFAULT_CALLBACK_PORT;
    // Can a first-run setup be offered? Only where what it produces can be stored, and macOS ACLs are
    // PER ITEM — so both halves are asked, the three values and the key. A locked keychain, a denied
    // prompt, or no keychain at all (#69) leaves `setupKey` unset, and then the degraded wording stands
    // instead of a page that could not save what it collected.
    let setupKey;
    if (!auth.ok && cacheOk) {
        try {
            readKeychainConfig(security);
            setupKey = resolveTokenStoreKey(security);
        }
        catch {
            // Nowhere to store an answer. `auth.reason` already says why.
        }
    }
    // Only the local (stdio/extension) path can receive the localhost OAuth callback; an injected
    // TokenProvider means the remote bridge already owns authorization. Kept out of ctx so the OAuth
    // client secret inside LoginDeps stays out of reach of the other 64 registrars.
    const login = deps.authManager
        ? undefined
        : auth.ok
            ? { config: auth.config, tokensPath, tokenStoreKey: auth.tokenStoreKey }
            : {
                config: noOAuthConfig(callbackPort),
                tokensPath,
                tokenStoreKey: setupKey ?? '',
                configError: auth.reason,
                setup: setupKey ? {} : undefined,
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
    let healed;
    let healedSubdomain = '';
    const configured = (config) => {
        healedSubdomain = config.subdomain;
        healed = new AuthManager(new TokenStore(tokensPath, setupKey), config, undefined, startLogin);
    };
    if (login?.setup)
        login.setup.onConfigured = configured;
    const authManager = (cacheOk ? deps.authManager : undefined) ??
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
    const ctx = {
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
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
    const { server } = createServer();
    await server.connect(new StdioServerTransport());
}
