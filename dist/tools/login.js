// src/tools/login.ts
// In-app OAuth login for the Desktop Extension. A Desktop user has no terminal, so the one-time
// authorization-code exchange that `npm run authorize` performs must be reachable as a tool.
//
// It runs in TWO calls, for the reason the README states under "Why `zendesk_login` exists". What
// follows from it here: the PKCE verifier and the CSRF `state` belong to the FLOW, not to the call
// — re-rolling them on the second call would invalidate the URL the user just opened.
//
// No new OAuth logic: PKCE, URL building, the listener and the token exchange all come from
// ../auth. What is added here is the flow state plus the presentation rules the MCP boundary
// needs: never touch stdout (it is the stdio transport), never surface a stack trace, a file path,
// or any secret.
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { generateCodeChallenge, generateCodeVerifier } from '../auth/pkce.js';
import { buildAuthorizationUrl, exchangeCodeForTokens, startCallbackListener, DEFAULT_CALLBACK_TIMEOUT_MS, } from '../auth/oauth-flow.js';
import { TokenStore } from '../auth/token-store.js';
const RETRY_RESOLVED = 'Run zendesk_login again once that is resolved.';
const RETRY_FRESH = 'Run zendesk_login again to start a new authorization.';
const UNREADABLE_STORE = 'Stored credentials could not be read (encryption secret changed or file corrupt) — starting a new authorization.';
let activeFlow = null;
// Ends any authorization in progress: closes the callback listener (freeing the port) and forgets
// the state, so the next zendesk_login starts a fresh flow with a fresh `state`. Used by
// force=true, by every terminal outcome, and by tests, which must not leak a bound listener into
// the next case.
export function abortLoginFlow() {
    if (!activeFlow)
        return;
    activeFlow.close();
    activeFlow = null;
}
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
// One line of prose for the user: never a stack, never a path, never a secret.
function failureText(err, deps) {
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
    // configuration field. Every other flow error (timed out, denied, exchange failure) already
    // arrives as prose from oauth-flow.ts and is passed through as-is. A denial is the one that
    // carries OUTSIDE text — the authorization server's `error` value — and oauth-flow.ts squeezes
    // that through the spec's character set before it ever reaches this line.
    return /EADDRINUSE|address already in use/i.test(message)
        ? `Zendesk login could not start: local port ${port} is already in use, so the OAuth callback cannot be received. Close whatever is listening on port ${port}, or set a different port in the "oauth_callback_port" configuration field and restart the extension.`
        : `Zendesk login failed: ${message}`;
}
// Call 1: build the URL, bind the listener, keep the flow, return — without waiting for the user.
async function beginFlow(deps, listen, timeoutMs) {
    const verifier = generateCodeVerifier();
    const state = randomBytes(16).toString('base64url');
    let url;
    let listener;
    try {
        url = buildAuthorizationUrl(deps.config, generateCodeChallenge(verifier), state);
        // Waiting for the bind is what lets a taken port be reported NOW, instead of handing out a URL
        // whose callback can never land. A subdomain that cannot form a URL fails one line earlier, and
        // in both cases nothing was bound and there is nothing to open — so this reply promises no URL.
        listener = await listen(deps.config.callbackPort, state, timeoutMs);
    }
    catch (err) {
        return `${failureText(err, deps)} ${RETRY_RESOLVED}`;
    }
    const flow = { verifier, url, outcome: { kind: 'pending' }, close: listener.close };
    // Attached before anything can await: the listener's rejection becomes a recorded outcome rather
    // than an unhandled rejection, however long the user takes to make the second call.
    void listener.promise.then((result) => {
        flow.outcome = { kind: 'received', result };
    }, (err) => {
        flow.outcome = { kind: 'failed', text: failureText(err, deps) };
    });
    activeFlow = flow;
    return [
        'Zendesk authorization started. Open this URL in your browser and approve access:',
        url,
        `Then run zendesk_login a second time to finish — this call does not wait for you. The authorization stays open for ${Math.round(timeoutMs / 60_000)} minute(s); after that, run zendesk_login to start over.`,
    ].join('\n');
}
// Call 2: whatever the running flow has become by now.
async function collectFlow(flow, deps, exchange) {
    const outcome = flow.outcome;
    if (outcome.kind === 'pending') {
        // The URL is repeated on purpose: by now the user may well have lost the first message, and
        // the state inside it is still the one this listener validates against.
        return [
            `Still waiting for the Zendesk authorization callback on port ${deps.config.callbackPort}. Open this URL in your browser and approve access:`,
            flow.url,
            'Then run zendesk_login again.',
        ].join('\n');
    }
    // Everything below ends the flow: an authorization code cannot be replayed, and a failed
    // listener is already closed. Dropping the flow here is what lets the NEXT call start cleanly.
    abortLoginFlow();
    if (outcome.kind === 'failed')
        return `${outcome.text} ${RETRY_FRESH}`;
    try {
        const tokens = await exchange(deps.config, outcome.result.code, flow.verifier, outcome.result.redirectUri);
        new TokenStore(deps.tokensPath, deps.config.clientSecret).save({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: Date.now() + tokens.expiresIn * 1000,
        });
    }
    catch (err) {
        return `${failureText(err, deps)} ${RETRY_FRESH}`;
    }
    return 'Authorization complete — the Zendesk credentials are stored encrypted and are refreshed automatically. Verify with zendesk_get_me.';
}
// Two zendesk_login calls can OVERLAP: the tool asks to be called twice, and a model that emits
// both tool_use blocks in one turn produces exactly that interleaving. Every call is therefore
// queued behind the one before it, which is the only thing that makes an overlapping second call
// behave like a sequential one — it finds the flow the first call started and collects it, instead
// of racing a rival listener onto the same port and telling the user to close whatever is listening
// there. (That was the synchronous `loginInFlight` marker's job before the two-call rewrite; a
// marker set after `await` reopened the window, because the reservation has to happen before the
// first await, and `activeFlow` cannot exist until the bind has resolved.)
let queue = Promise.resolve();
// One handler for both outcomes: the queue is never read for its value, and a step that rejected
// must not poison every login after it.
const settled = () => { };
export function runLogin(deps, options = {}) {
    const next = queue.then(() => runQueuedLogin(deps, options));
    queue = next.then(settled, settled);
    return next;
}
async function runQueuedLogin(deps, options) {
    if (deps.configError)
        return deps.configError;
    const timeoutMs = deps.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
    const listen = deps.listen ?? startCallbackListener;
    const exchange = deps.exchange ?? exchangeCodeForTokens;
    // force means "start over": abandon a flow in progress instead of collecting it, so a user who
    // lost the browser tab is not stuck until the listener times out.
    if (options.force)
        abortLoginFlow();
    if (activeFlow)
        return collectFlow(activeFlow, deps, exchange);
    const existing = readExistingTokens(deps);
    if (!options.force && existing.tokens) {
        return 'Already authorized with Zendesk — the stored credentials are usable and are refreshed automatically. Verify with zendesk_get_me, or call zendesk_login with force=true to authorize again.';
    }
    const notice = existing.unreadable ? `${UNREADABLE_STORE}\n` : '';
    return notice + (await beginFlow(deps, listen, timeoutMs));
}
