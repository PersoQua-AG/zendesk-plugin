import { createServer, type Server } from 'node:http';
import { z } from 'zod';

const DEFAULT_CALLBACK_TIMEOUT_MS = 300_000;

// Zendesk's token endpoint is a trust boundary: a malformed body (e.g. missing
// expires_in) must fail loudly here, not silently produce expiresAt=NaN downstream.
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().finite(),
});

export interface OAuthConfig {
  subdomain: string;
  clientId: string;
  clientSecret: string;
  callbackPort: number;
  scopes: string[];
}

export interface AuthorizationResult {
  code: string;
  redirectUri: string;
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function redirectUri(port: number): string {
  return `http://localhost:${port}/callback`;
}

// redirectUriOverride lets the remote bridge point Zendesk at its PUBLIC /callback; stdio callers
// omit it and keep the localhost loopback redirect unchanged.
export function buildAuthorizationUrl(
  config: OAuthConfig,
  codeChallenge: string,
  state: string,
  redirectUriOverride?: string,
): string {
  const url = new URL(`https://${config.subdomain}.zendesk.com/oauth/authorizations/new`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUriOverride ?? redirectUri(config.callbackPort));
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export function waitForAuthorizationCode(
  port: number,
  expectedState: string,
  timeoutMs: number = DEFAULT_CALLBACK_TIMEOUT_MS,
): Promise<AuthorizationResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server: Server = createServer((req, res) => {
      // req.url is typed `string | undefined` but is always set on a request the parser accepted,
      // so the fallback exists for the type only and no test can reach it.
      /* v8 ignore next */
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const fail = (status: number, body: string, message: string): void => {
        res.writeHead(status, { 'Content-Type': 'text/plain' }).end(body);
        finish(() => reject(new Error(message)));
      };

      const error = url.searchParams.get('error');
      if (error) {
        return fail(400, `Authorization failed: ${error}`, `OAuth authorization failed: ${error}`);
      }
      if (url.searchParams.get('state') !== expectedState) {
        return fail(400, 'State mismatch', 'OAuth state mismatch — possible CSRF');
      }
      const code = url.searchParams.get('code');
      if (!code) {
        return fail(400, 'Missing code', 'OAuth callback missing code');
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Authorized. You can close this tab.');
      finish(() => resolve({ code, redirectUri: redirectUri(port) }));
    });

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`OAuth callback timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.();

    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      settle();
    };

    // Bind errors (e.g. EADDRINUSE) reject the promise instead of throwing uncaught.
    server.on('error', (err) => finish(() => reject(new Error(`OAuth callback server error: ${err.message}`))));
    server.listen(port);
  });
}

async function postToken(
  subdomain: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  errorLabel: string,
): Promise<TokenResponse> {
  const response = await fetchImpl(`https://${subdomain}.zendesk.com/oauth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${errorLabel}: ${response.status} ${await response.text()}`);
  }
  const parsed = tokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    // Report which fields are wrong, never the raw body (it carries the tokens).
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`${errorLabel}: malformed token response (invalid/missing: ${fields})`);
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresIn: parsed.data.expires_in,
  };
}

export function exchangeCodeForTokens(
  config: OAuthConfig,
  code: string,
  codeVerifier: string,
  redirectUriValue: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  return postToken(
    config.subdomain,
    {
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUriValue,
      code_verifier: codeVerifier,
      scope: config.scopes.join(' '),
    },
    fetchImpl,
    'Token exchange failed',
  );
}

export function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  return postToken(
    config.subdomain,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    },
    fetchImpl,
    'Token refresh failed',
  );
}
