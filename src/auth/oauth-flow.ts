import { createServer, type Server } from 'node:http';

const DEFAULT_CALLBACK_TIMEOUT_MS = 300_000;

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

export function buildAuthorizationUrl(config: OAuthConfig, codeChallenge: string, state: string): string {
  const url = new URL(`https://${config.subdomain}.zendesk.com/oauth/authorizations/new`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri(config.callbackPort));
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
  const parsed = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return { accessToken: parsed.access_token, refreshToken: parsed.refresh_token, expiresIn: parsed.expires_in };
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
