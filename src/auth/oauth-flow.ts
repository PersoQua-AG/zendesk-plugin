import { createServer, type Server } from 'node:http';

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

export function buildAuthorizationUrl(config: OAuthConfig, codeChallenge: string, state: string): string {
  const redirectUri = `http://localhost:${config.callbackPort}/callback`;
  const url = new URL(`https://${config.subdomain}.zendesk.com/oauth/authorizations/new`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export function waitForAuthorizationCode(port: number, expectedState: string): Promise<AuthorizationResult> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Authorization failed: ${error}`);
        server.close();
        reject(new Error(`OAuth authorization failed: ${error}`));
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('State mismatch');
        server.close();
        reject(new Error('OAuth state mismatch — possible CSRF'));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Missing code');
        server.close();
        reject(new Error('OAuth callback missing code'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Authorized. You can close this tab.');
      server.close();
      resolve({ code, redirectUri: `http://localhost:${port}/callback` });
    });
    server.listen(port);
  });
}
