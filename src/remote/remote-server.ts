import express, { type Application, type Request, type Response } from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
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
import { log } from './logger.js';

const BODY_LIMIT = '4mb';

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
  const encryptionSecret = config.clientSecret; // server-held key; from a secrets manager in prod

  const resolver = deps.resolver ?? new IdentityAuthResolver(new IdentityTokenStore(`${dataDir}/users`, encryptionSecret), config);
  const issued = deps.issued ?? new IssuedTokenStore(`${dataDir}/issued`, encryptionSecret);
  const audit = deps.audit ?? new WriteAuditLog(`${dataDir}/audit/write-audit.jsonl`);
  // SHARED rate buckets across all sessions — the Zendesk 400/min + 10/min budget is account-wide.
  const rateLimiter = deps.rateLimiter ?? new RateLimiter({ requestsPerMinute: DEFAULT_RATE_LIMIT_RPM });
  const incrementalRateLimiter = deps.incrementalRateLimiter ?? new RateLimiter({ requestsPerMinute: INCREMENTAL_RATE_LIMIT_RPM });

  const sessions = new SessionManager(env, { resolver, rateLimiter, incrementalRateLimiter, dataDir, audit, fetchImpl: deps.fetchImpl });
  const provider = new ZendeskBridgeOAuthProvider(config, resolver, issued, CONNECTOR.clientsStore(), deps.fetchImpl ?? fetch);

  const app = express();
  app.use(express.json({ limit: BODY_LIMIT }));
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
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
function fail(res: Response, err: unknown): void {
  const msg = err instanceof Error ? err.message : 'request error';
  log({ msg: `mcp request error: ${msg}`, outcome: 'error' });
  if (!res.headersSent) res.status(400).end();
}
