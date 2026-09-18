import { createServer } from 'node:http';
import { z } from 'zod';
import { CALLBACK_PORT_RULE } from './config.js';
// The human step this bounds: open the URL, sign in to Zendesk, clear SSO/2FA, approve. Exported
// because the login tool bounds the very same step and must not drift from it.
export const DEFAULT_CALLBACK_TIMEOUT_MS = 300_000;
// Zendesk's token endpoint is a trust boundary: a malformed body (e.g. missing
// expires_in) must fail loudly here, not silently produce expiresAt=NaN downstream.
const tokenResponseSchema = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_in: z.number().finite(),
});
function redirectUri(port) {
    return `http://localhost:${port}/callback`;
}
// redirectUriOverride lets the remote bridge point Zendesk at its PUBLIC /callback; stdio callers
// omit it and keep the localhost loopback redirect unchanged.
export function buildAuthorizationUrl(config, codeChallenge, state, redirectUriOverride) {
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
// Resolves only once the port is actually bound, and REJECTS on a bind failure (e.g. EADDRINUSE) —
// so a caller never receives a listener whose callback could never land, and never has to inspect
// an error returned as a value.
export function startCallbackListener(port, expectedState, timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS) {
    return new Promise((bound, bindFailed) => {
        let close;
        // Assigned synchronously by the executor below, so that server.listen() can be called from THIS
        // executor rather than that one — see the comment at the call.
        let server;
        const promise = new Promise((resolve, reject) => {
            let settled = false;
            server = createServer((req, res) => {
                // req.url is typed `string | undefined` but is always set on a request the parser accepted,
                // so the fallback exists for the type only and no test can reach it.
                /* v8 ignore next */
                const rawUrl = req.url ?? '/';
                // Not every request-target node's HTTP parser accepts is a URL this base can resolve.
                // Measured on node v22: llhttp delivers "//", "///", "//%" and "http://" unchanged, and
                // WHATWG rejects all four (empty authority) — `new URL` throws TypeError [ERR_INVALID_URL].
                // Thrown from a 'request' listener that is an uncaughtException, so it did not fail the
                // callback, it killed the whole stdio server: the extension is gone and every tool with it,
                // for the five minutes the listener is open, on a port any local process can reach. A
                // browser sent to http://localhost:<port>// is enough to produce it. The suite could not
                // see it because every test drives the listener through fetch(), which normalizes the
                // target and can never emit one of these.
                //
                // The remedy is 400 and keep listening, not a settled flow: a request this malformed is not
                // the user's browser coming back from Zendesk, so the pending authorization must survive it
                // exactly as it survives the 404 below.
                let url;
                try {
                    url = new URL(rawUrl, `http://localhost:${port}`);
                }
                catch {
                    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request target');
                    return;
                }
                if (url.pathname !== '/callback') {
                    res.writeHead(404).end();
                    return;
                }
                const fail = (status, body, message) => {
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
            const finish = (settle) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                server.close();
                settle();
            };
            close = () => finish(() => reject(new Error('OAuth callback listener closed')));
            server.on('error', (err) => {
                const bindError = new Error(`OAuth callback server error: ${err.message}`);
                finish(() => reject(bindError));
                bindFailed(bindError);
            });
            server.on('listening', () => bound({ promise, close }));
        });
        // On a bind failure nobody holds `promise` yet — it is rejected before this function resolves,
        // which would surface as an unhandled rejection. The bind error reaches the caller through
        // bindFailed instead; a caller that DOES hold the listener still sees its own rejection.
        promise.catch(() => { });
        // listen() stands HERE, in the outer executor and after that catch, on purpose. It validates its
        // port synchronously and throws a RangeError for anything that is not a whole number in 0–65535
        // — a throw that is never delivered as an 'error' event. Standing here, such a throw rejects the
        // Promise this function returns by plain Promise semantics: settling is a property of WHERE the
        // call stands, not of catching the right things. Inside the inner executor it rejected `promise`
        // instead, which the catch above swallows, so neither `bound` nor `bindFailed` was ever called
        // and startCallbackListener() stayed pending forever — beginFlow() never returned and the login
        // queue in ../tools/login.ts held every later zendesk_login behind it until a restart.
        try {
            server.listen(port);
        }
        catch {
            // Cleanup and wording only, NOT liveness: whatever this block does, the throw out of it
            // rejects the returned Promise. close() runs finish() — clearing the timer, closing the
            // server and settling `promise` — so a refused bind leaves nothing behind. The RangeError's
            // own text names node internals and no remedy, so it is replaced rather than passed on; a
            // synchronous listen() failure has exactly one cause, the port value.
            close();
            throw new Error(`OAuth callback server could not start on port ${port} (${CALLBACK_PORT_RULE}).`);
        }
    });
}
// The CLI's shape: start the listener and wait for it in one call.
export async function waitForAuthorizationCode(port, expectedState, timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS) {
    return (await startCallbackListener(port, expectedState, timeoutMs)).promise;
}
// NFR-1: an error body reaches the user. Zendesk answers with a short JSON error, but anything in
// front of it (a WAF, a captive portal, a proxy) can answer with a whole HTML page — measured: an
// ~8 KB Cloudflare challenge carrying a cf_chl_tk token, all on ONE line, which a first-line-only
// cut passes through untouched. So the body is capped on BOTH axes, and markup is dropped entirely
// rather than quoted.
const MAX_ERROR_BODY_CHARS = 200;
function summarizeErrorBody(raw) {
    const firstLine = raw.split('\n')[0].trim();
    if (firstLine.startsWith('<'))
        return '(non-text response body omitted)';
    return firstLine.length > MAX_ERROR_BODY_CHARS
        ? `${firstLine.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated)`
        : firstLine;
}
// Unlike the callback timeout above, this one bounds a MACHINE step: one POST to Zendesk's token
// endpoint with no human in it. Left without a signal the wait is not zero, it is undici's
// headersTimeout (~300 s) — inherited rather than chosen, and the whole time the login queue in
// ../tools/login.ts holds every other zendesk_login behind it, force=true included. 30 s is well
// above any healthy token round trip (Zendesk answers in well under a second) and short enough that
// the user gets an answer inside the turn that asked for it, instead of a tool call that never
// returns.
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
// Thrown by fetch when the signal above fires: undici rejects with the signal's reason, and
// AbortSignal.timeout's reason is a DOMException named TimeoutError. Its own message ("The
// operation was aborted due to timeout") names no remedy, so it is replaced rather than passed on.
function isRequestTimeout(err) {
    return err instanceof Error && err.name === 'TimeoutError';
}
async function postToken(subdomain, body, fetchImpl, errorLabel) {
    let response;
    try {
        response = await fetchImpl(`https://${subdomain}.zendesk.com/oauth/tokens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        });
    }
    catch (err) {
        if (!isRequestTimeout(err))
            throw err;
        throw new Error(`${errorLabel}: no reply from the Zendesk token endpoint within ${TOKEN_REQUEST_TIMEOUT_MS / 1000} seconds — check the network connection, and any proxy or VPN between this machine and Zendesk.`);
    }
    if (!response.ok) {
        throw new Error(`${errorLabel}: ${response.status} ${summarizeErrorBody(await response.text())}`);
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
export function exchangeCodeForTokens(config, code, codeVerifier, redirectUriValue, fetchImpl = fetch) {
    return postToken(config.subdomain, {
        grant_type: 'authorization_code',
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: redirectUriValue,
        code_verifier: codeVerifier,
        scope: config.scopes.join(' '),
    }, fetchImpl, 'Token exchange failed');
}
export function refreshAccessToken(config, refreshToken, fetchImpl = fetch) {
    return postToken(config.subdomain, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
    }, fetchImpl, 'Token refresh failed');
}
