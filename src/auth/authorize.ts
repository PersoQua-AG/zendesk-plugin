import { randomBytes } from 'node:crypto';
import { generateCodeVerifier, generateCodeChallenge } from './pkce.js';
import {
  buildAuthorizationUrl,
  waitForAuthorizationCode,
  exchangeCodeForTokens,
  type OAuthConfig,
  type AuthorizationResult,
} from './oauth-flow.js';
import { TokenStore } from './token-store.js';

export interface AuthorizeDeps {
  config: OAuthConfig;
  // The resolved token file path from resolveAuthConfig — the single source of truth the server
  // also reads, so the two never derive divergent locations.
  tokensPath: string;
  waitForCode?: (port: number, state: string) => Promise<AuthorizationResult>;
  exchange?: typeof exchangeCodeForTokens;
  generateVerifier?: () => string;
  generateState?: () => string;
  now?: () => number;
  print?: (line: string) => void;
}

// Pure composition of the existing PKCE / OAuth-flow / token-store modules — no
// new crypto or HTTP logic. Runs the one-time authorization-code exchange the
// server cannot do (it only refreshes), then persists tokens the server reads.
export async function authorize(deps: AuthorizeDeps): Promise<void> {
  const {
    config,
    tokensPath,
    waitForCode = waitForAuthorizationCode,
    exchange = exchangeCodeForTokens,
    generateVerifier = generateCodeVerifier,
    generateState = () => randomBytes(16).toString('base64url'),
    now = Date.now,
    print = (line) => process.stdout.write(`${line}\n`),
  } = deps;

  const verifier = generateVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = generateState();
  const url = buildAuthorizationUrl(config, challenge, state);

  print('Open this URL in your browser to authorize the Zendesk plugin:');
  print(url);
  print(`Waiting for the callback on http://localhost:${config.callbackPort}/callback ...`);

  const result = await waitForCode(config.callbackPort, state);
  const tokens = await exchange(config, result.code, verifier, result.redirectUri);

  const store = new TokenStore(tokensPath, config.clientSecret);
  store.save({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: now() + tokens.expiresIn * 1000,
  });

  print('Authorization complete. Tokens saved securely. You can now use the Zendesk plugin.');
}
