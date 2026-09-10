// src/tools/login.ts
// In-app OAuth login for the Desktop Extension. A Desktop user has no terminal, so the one-time
// authorization-code exchange that `npm run authorize` performs must be reachable as a tool. This
// is pure composition of the existing authorize()/oauth-flow modules — no new OAuth logic — plus
// the presentation rules the MCP boundary needs: never touch stdout (it is the stdio transport),
// never surface a stack trace, a file path, or any secret.
import { dirname } from 'node:path';
import { authorize, type AuthorizeDeps } from '../auth/authorize.js';
import { waitForAuthorizationCode, type AuthorizationResult, type OAuthConfig } from '../auth/oauth-flow.js';
import { TokenStore, type StoredTokens } from '../auth/token-store.js';

// The host kills a tool call that runs too long, so the login path waits far less than the CLI's
// 300s default. Configurable via deps, deliberately NOT exposed as a user_config field.
export const LOGIN_CALLBACK_TIMEOUT_MS = 120_000;

export interface LoginDeps {
  config: OAuthConfig;
  tokensPath: string;
  // Set when the extension started with incomplete configuration: every login attempt reports what
  // to fill in rather than opening a doomed flow.
  configError?: string | null;
  callbackTimeoutMs?: number;
  waitForCode?: (port: number, state: string) => Promise<AuthorizationResult>;
  exchange?: AuthorizeDeps['exchange'];
  loadTokens?: () => StoredTokens | null;
  authorizeImpl?: (deps: AuthorizeDeps) => Promise<void>;
}

const RETRY = 'Run zendesk_login again once that is resolved.';

// Tokens the store can decrypt and that carry a refresh token are enough: the server refreshes
// silently from there, so a new authorization-code round trip would only cost the user a browser
// detour. A load failure (rotated secret, corrupt file) falls through to a fresh flow.
function existingTokens(deps: LoginDeps): StoredTokens | null {
  const load = deps.loadTokens ?? (() => new TokenStore(deps.tokensPath, deps.config.clientSecret).load());
  try {
    const tokens = load();
    return tokens?.refreshToken ? tokens : null;
  } catch {
    return null;
  }
}

function failureText(err: unknown, deps: LoginDeps): string {
  const raw = err instanceof Error ? err.message : String(err);
  // First line only (never a stack) and with the data-dir paths redacted.
  const message = raw
    .split('\n')[0]
    .split(deps.tokensPath)
    .join('the token store')
    .split(dirname(deps.tokensPath))
    .join('the data directory');
  const port = deps.config.callbackPort;

  if (/EADDRINUSE|address already in use/i.test(message)) {
    return `Zendesk login could not start: local port ${port} is already in use, so the OAuth callback cannot be received. Close whatever is listening on port ${port}, or set a different port in the "oauth_callback_port" configuration field and restart the extension. ${RETRY}`;
  }
  if (/timed out/i.test(message)) {
    return `Zendesk login timed out: the browser authorization was not completed in time. The local callback listener on port ${port} has been closed. ${RETRY}`;
  }
  if (/state mismatch/i.test(message)) {
    return `Zendesk login was rejected: OAuth state mismatch — the callback did not belong to this login attempt. ${RETRY}`;
  }
  return `Zendesk login failed: ${message} ${RETRY}`;
}

export async function runLogin(deps: LoginDeps, force = false): Promise<string> {
  if (deps.configError) return deps.configError;

  if (!force && existingTokens(deps)) {
    return 'Already authorized with Zendesk — the stored credentials are usable and are refreshed automatically. Verify with zendesk_get_me, or call zendesk_login with force=true to authorize again.';
  }

  const timeoutMs = deps.callbackTimeoutMs ?? LOGIN_CALLBACK_TIMEOUT_MS;
  const lines: string[] = [];
  try {
    await (deps.authorizeImpl ?? authorize)({
      config: deps.config,
      tokensPath: deps.tokensPath,
      exchange: deps.exchange,
      waitForCode: deps.waitForCode ?? ((port, state) => waitForAuthorizationCode(port, state, timeoutMs)),
      // stdout is the MCP stdio transport: collect the flow's output instead of writing it.
      print: (line) => lines.push(line),
    });
  } catch (err) {
    return failureText(err, deps);
  }
  return lines.join('\n');
}
