import express, { type Application, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
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

// JSON-RPC/OAuth payloads are small; a 4mb body on unauthenticated routes is a memory-amplification
// vector. 256kb is generous for both (H1).
const BODY_LIMIT = '256kb';
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily retention sweep (D3/A7)
const RATE_WINDOW_MS = 60_000;
const OAUTH_RATE_LIMIT = 60; // per IP/min on the unauthenticated OAuth/DCR surface (H1)
const MCP_RATE_LIMIT = 600; // per IP/min on /mcp (authenticated, higher — JSON-RPC is chatty)
// Minimum entropy for the data-encryption key (M3): 32 bytes = a 256-bit AES key's worth.
const MIN_ENC_KEY_BYTES = 32;

// Best-effort byte-strength of a key string: hex → nibble pairs, base64 → decoded length, else the
// raw utf8 byte length. Used only to reject obviously weak keys, not as a cryptographic measure.
function encKeyStrengthBytes(key: string): number {
  if (/^[0-9a-fA-F]+$/.test(key) && key.length % 2 === 0) return key.length / 2;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(key)) return Buffer.from(key, 'base64').length;
  return Buffer.byteLength(key, 'utf8');
}

// Downstream (claude.ai) redirect hosts we will 302 to from /callback. Defaults to claude.ai; ops
// can widen via REMOTE_ALLOWED_REDIRECT_HOSTS (comma-separated hosts). https-only, host-exact (M1).
function allowedRedirectHosts(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.REMOTE_ALLOWED_REDIRECT_HOSTS;
  const hosts = raw ? raw.split(',').map((h) => h.trim()).filter(Boolean) : ['claude.ai'];
  return new Set(hosts);
}

function assertAllowedRedirect(uri: string, hosts: Set<string>): URL {
  const url = new URL(uri);
  if (url.protocol !== 'https:' || !hosts.has(url.host)) throw new Error('redirect_uri not allowed.');
  return url;
}

// Injection seam for tests (mock Zendesk fetch, pre-seed identities/issued tokens). Every field
// defaults to an env-derived production construction.
export interface RemoteDeps {
  resolver?: IdentityAuthResolver;
  issued?: IssuedTokenStore;
  audit?: WriteAuditLog;
  rateLimiter?: RateLimiter;
  incrementalRateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
}

export interface RemoteApp {
  app: Application;
  provider: ZendeskBridgeOAuthProvider;
  issued: IssuedTokenStore;
  resolver: IdentityAuthResolver;
}

// Build the remote MCP express app (no listen — callers/tests attach a server). Reuses
// createServer() per session via SessionManager; the stdio entrypoint is untouched.
export function buildRemoteApp(env: NodeJS.ProcessEnv = process.env, deps: RemoteDeps = {}): RemoteApp {
  const { config, dataDir } = resolveAuthConfig(env);
  // Data-encryption key is DISTINCT from the OAuth client secret and independently rotatable:
  // rotating the client secret must not brick per-user token files, and the client secret must not
  // double as the decrypt-all key. Required (fail-closed) whenever a default store is constructed.
  const requireEncKey = (): string => {
    const key = env.REMOTE_TOKEN_ENC_KEY;
    if (!key) throw new Error('REMOTE_TOKEN_ENC_KEY is required (data-encryption key for the per-user token stores).');
    if (encKeyStrengthBytes(key) < MIN_ENC_KEY_BYTES) {
      throw new Error('REMOTE_TOKEN_ENC_KEY is too weak: need >=32 bytes of entropy. Generate one with: openssl rand -base64 32');
    }
    return key;
  };

  const resolver = deps.resolver ?? new IdentityAuthResolver(new IdentityTokenStore(`${dataDir}/users`, requireEncKey()), config);
  const issued = deps.issued ?? new IssuedTokenStore(`${dataDir}/issued`, requireEncKey());
  const audit = deps.audit ?? new WriteAuditLog(`${dataDir}/audit/write-audit.jsonl`);
  // Enforce retention at startup, then on an unref'd daily timer so the sweep never holds the
  // process open (D3/A7). No external cron/manual command required. The issued-token sweep rides the
  // same timer so expired opaque-token files can't accumulate to disk-full (H2).
  const prune = (): void => {
    audit.prune();
    issued.prune();
  };
  prune();
  setInterval(prune, PRUNE_INTERVAL_MS).unref?.();
  // SHARED rate buckets across all sessions — the Zendesk 400/min + 10/min budget is account-wide.
  const rateLimiter = deps.rateLimiter ?? new RateLimiter({ requestsPerMinute: DEFAULT_RATE_LIMIT_RPM });
  const incrementalRateLimiter = deps.incrementalRateLimiter ?? new RateLimiter({ requestsPerMinute: INCREMENTAL_RATE_LIMIT_RPM });

  const sessions = new SessionManager(env, { resolver, rateLimiter, incrementalRateLimiter, dataDir, audit, fetchImpl: deps.fetchImpl });
  const provider = new ZendeskBridgeOAuthProvider(config, resolver, issued, CONNECTOR.clientsStore(), deps.fetchImpl ?? fetch, CONNECTOR.callbackUrl);

  const app = express();
  app.use(express.json({ limit: BODY_LIMIT }));
  // HTTP-layer per-IP rate limits in front of the unauthenticated OAuth/DCR surface and /mcp (H1).
  const limit = (max: number) => rateLimit({ windowMs: RATE_WINDOW_MS, limit: max, standardHeaders: true, legacyHeaders: false });
  app.use(['/register', '/authorize', '/token', '/callback'], limit(OAUTH_RATE_LIMIT));
  app.use('/mcp', limit(MCP_RATE_LIMIT));
  const redirectHosts = allowedRedirectHosts(env);
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // Upstream Zendesk redirect target. No bearer (it's a browser redirect from Zendesk). Verify +
  // single-use-consume the anti-CSRF state, then hand the code back to the downstream (claude.ai)
  // redirect stashed at authorize time.
  app.get('/callback', (req: Request, res: Response) => {
    const code = req.query.code;
    const state = req.query.state;
    if (typeof code !== 'string' || typeof state !== 'string') {
      res.status(400).end('Missing code or state.');
      return;
    }
    let pending: { redirectUri: string };
    try {
      pending = issued.consumePendingRedirect(state);
    } catch (e: unknown) {
      log({ msg: `oauth callback rejected: ${describeAuthError(e)}`, outcome: '403' });
      res.status(403).end('OAuth state mismatch or expired.');
      return;
    }
    let target: URL;
    try {
      // Open-redirect guard: only 302 to an https host on the allowlist, even though the redirect was
      // stored at authorize time (an attacker-registered DCR client could have supplied it) (M1).
      target = assertAllowedRedirect(pending.redirectUri, redirectHosts);
    } catch (e: unknown) {
      log({ msg: `oauth callback rejected: ${describeAuthError(e)}`, outcome: '403' });
      res.status(403).end('redirect_uri not allowed.');
      return;
    }
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
  app.post('/mcp', bearer, (req: Request, res: Response) =>
    sessions.handlePost(req, res).catch((e: unknown) => fail(res, e)),
  );
  app.get('/mcp', bearer, (req: Request, res: Response) => sessions.handleGet(req, res).catch((e: unknown) => fail(res, e)));
  app.delete('/mcp', bearer, (req: Request, res: Response) => sessions.handleDelete(req, res).catch((e: unknown) => fail(res, e)));

  return { app, provider, issued, resolver };
}

// Surface a 400 without ever logging the request body (REQ-1 negative: no body content in logs).
// The logged line uses the actionable auth/session copy, never a stack trace.
function fail(res: Response, err: unknown): void {
  // A missing/invalid identity is a re-auth signal (401); any other request error stays a fail-closed 400.
  const status = err instanceof InvalidTokenError ? 401 : 400;
  log({ msg: `mcp request error: ${describeAuthError(err)}`, outcome: String(status) });
  if (!res.headersSent) res.status(status).end();
}
