// src/tools/login.ts
// In-app OAuth login for the Desktop Extension. A Desktop user has no terminal, so the one-time
// authorization-code exchange that `npm run authorize` performs must be reachable as a tool. This
// is pure composition of the existing authorize()/oauth-flow modules — no new OAuth logic — plus
// the presentation rules the MCP boundary needs: never touch stdout (it is the stdio transport),
// never surface a stack trace, a file path, or any secret.
import { dirname } from 'node:path';
import { authorize } from '../auth/authorize.js';
import { waitForAuthorizationCode } from '../auth/oauth-flow.js';
import { TokenStore } from '../auth/token-store.js';
// The host kills a tool call that runs too long, so the login path waits far less than the CLI's
// 300s default. Configurable via deps, deliberately NOT exposed as a user_config field.
export const LOGIN_CALLBACK_TIMEOUT_MS = 120_000;
const RETRY = 'Run zendesk_login again once that is resolved.';
const UNREADABLE_STORE = 'Stored credentials could not be read (encryption secret changed or file corrupt) — starting a new authorization.';
// A single login call blocks for up to LOGIN_CALLBACK_TIMEOUT_MS, long enough for the model to
// fire a second zendesk_login while the first still owns the callback port. Without this marker the
// second call binds the same port, gets EADDRINUSE from the FIRST login, and tells the user to
// close whatever is listening — i.e. blames them for their own pending authorization.
let loginInFlight = false;
// Tokens the store can decrypt and that carry a refresh token are enough: the server refreshes
// silently from there, so a new authorization-code round trip would only cost the user a browser
// detour. A load failure (rotated secret, corrupt file) falls through to a fresh flow — but says
// so, because silently discarding stored credentials is exactly what a user wants explained.
function readExistingTokens(deps) {
    try {
        const tokens = new TokenStore(deps.tokensPath, deps.config.clientSecret).load();
        return { tokens: tokens?.refreshToken ? tokens : null, unreadable: false };
    }
    catch {
        return { tokens: null, unreadable: true };
    }
}
// The authorization URL is the entire point of this tool: a user who never sees it cannot finish
// the flow. authorize() prints it BEFORE it starts waiting, so it is already in `lines` on every
// path that fails afterwards — timeout, state mismatch, denied, bind failure, exchange failure.
function failureText(err, deps, lines) {
    const raw = err instanceof Error ? err.message : String(err);
    // First line only (never a stack) and with the data-dir paths redacted.
    const message = raw
        .split('\n')[0]
        .split(deps.tokensPath)
        .join('the token store')
        .split(dirname(deps.tokensPath))
        .join('the data directory');
    const port = deps.config.callbackPort;
    // Only EADDRINUSE needs translating: an errno tells the user nothing and the remedy names a
    // configuration field. Every other flow error (timed out, state mismatch, denied, exchange
    // failure) already arrives as prose from oauth-flow.ts and is passed through as-is.
    const head = /EADDRINUSE|address already in use/i.test(message)
        ? `Zendesk login could not start: local port ${port} is already in use, so the OAuth callback cannot be received. Close whatever is listening on port ${port}, or set a different port in the "oauth_callback_port" configuration field and restart the extension.`
        : `Zendesk login failed: ${message}`;
    const url = lines.find((line) => line.startsWith('https://'));
    return url ? `${head} ${RETRY}\nAuthorization URL for this attempt — open it in a browser:\n${url}` : `${head} ${RETRY}`;
}
export async function runLogin(deps, options = {}) {
    if (deps.configError)
        return deps.configError;
    const existing = readExistingTokens(deps);
    if (!options.force && existing.tokens) {
        return 'Already authorized with Zendesk — the stored credentials are usable and are refreshed automatically. Verify with zendesk_get_me, or call zendesk_login with force=true to authorize again.';
    }
    if (loginInFlight) {
        return `A Zendesk login is already waiting for the callback on port ${deps.config.callbackPort}. Finish that authorization in the browser, or wait for it to time out, then run zendesk_login again.`;
    }
    const notice = existing.unreadable ? `${UNREADABLE_STORE}\n` : '';
    const timeoutMs = deps.callbackTimeoutMs ?? LOGIN_CALLBACK_TIMEOUT_MS;
    const lines = [];
    loginInFlight = true;
    try {
        await authorize({
            config: deps.config,
            tokensPath: deps.tokensPath,
            exchange: deps.exchange,
            waitForCode: deps.waitForCode ?? ((port, state) => waitForAuthorizationCode(port, state, timeoutMs)),
            // stdout is the MCP stdio transport: collect the flow's output instead of writing it.
            print: (line) => lines.push(line),
        });
    }
    catch (err) {
        return notice + failureText(err, deps, lines);
    }
    finally {
        loginInFlight = false;
    }
    return notice + lines.join('\n');
}
