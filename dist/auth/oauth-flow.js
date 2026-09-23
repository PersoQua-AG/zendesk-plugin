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
// The `error` value arrives from outside and leaves as TEXT THE MODEL READS: it is interpolated
// into the listener's rejection, which ../tools/login.ts turns into the zendesk_login result. So it
// is squeezed through the character set the spec gives it before it is interpolated anywhere.
//
// RFC 6749 §4.1.2.1 defines the value as *NQCHAR — %x20-21 / %x23-5B / %x5D-7E, printable ASCII
// without '"' and '\'. A character outside that set is not a legal error code in the first place,
// so it is DROPPED rather than escaped: NUL, CR and LF (which made one value look like several
// lines of prose), C1 controls, and every non-ASCII lookalike a homoglyph or a bidi override could
// be written with.
//
// Not narrowed to the §4.1.2.1 code LIST, deliberately. That list is seven values, and Zendesk's
// own documented errors already include two that are not on it — `invalid_grant` and
// `redirect_uri_mismatch` (developer.zendesk.com, "Using OAuth to authenticate API requests",
// "Common errors"). The second is the most actionable error the flow has, because it names a
// configuration field the user must fix; rendering it as "unknown error code" would trade a
// nonexistent injection gain (the set above already contains nothing executable, and the caller
// already holds `state`) for a user who cannot tell what went wrong.
const NOT_NQCHAR = /[^\x20-\x21\x23-\x5B\x5D-\x7E]/g;
// Long enough for any real code plus a word of context, short enough that nothing can pad the tool
// result with content of its own. The longest value Zendesk documents is 21 characters.
const MAX_ERROR_CODE_CHARS = 100;
function sanitizeErrorCode(raw) {
    const cleaned = raw.replace(NOT_NQCHAR, '').trim();
    // Everything was dropped: say so, rather than render an empty reason as if none had been given.
    if (!cleaned)
        return '(unprintable error code)';
    return cleaned.length > MAX_ERROR_CODE_CHARS
        ? `${cleaned.slice(0, MAX_ERROR_CODE_CHARS)}… (truncated)`
        : cleaned;
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
            // Every call below is wrapped, not just the one that bit us in #9. This is the INNER
            // executor: a synchronous throw in here rejects `promise`, which the catch below this
            // function swallows, so the promise startCallbackListener() returns would never settle and
            // every serialized login behind it would hang. bindFailed() settles the one the caller
            // actually holds. Enforced by scripts/assert-executor-safety.mjs.
            try {
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
                    // `state` FIRST, before any other query parameter is read, and a request that fails it ends
                    // like the 404 above: 400, keep listening, pending authorization untouched. `state` is the
                    // only thing separating the user's browser coming back from Zendesk from any other caller,
                    // and on a fixed local port held open for five minutes every local process is a possible
                    // caller — a browser tab included, since fetch's no-cors mode is blocked from READING the
                    // answer, not from sending the request. Checked second, as it was, an `error=` from such a
                    // caller did two things it must not: it ENDED the authorization the user was in the middle
                    // of, and it put text of its own choosing into the rejection the model reads as tool output
                    // (../tools/login.ts failureText).
                    //
                    // The order costs nothing, because a genuine denial carries `state` too: "If the user
                    // denies access, Zendesk redirects to your app with an error and the same state value you
                    // sent: …?error=access_denied&state=xyz789" (developer.zendesk.com, "Using OAuth to
                    // authenticate API requests", step 3) — which RFC 6749 §4.1.2.1 requires of any
                    // authorization server ("state: REQUIRED if a 'state' parameter was present in the client
                    // authorization request"). So a denial still settles AT ONCE, and nobody waits out the
                    // window for an answer that already exists.
                    if (url.searchParams.get('state') !== expectedState) {
                        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('State mismatch');
                        return;
                    }
                    const fail = (status, body, message) => {
                        res.writeHead(status, { 'Content-Type': 'text/plain' }).end(body);
                        finish(() => reject(new Error(message)));
                    };
                    const error = url.searchParams.get('error');
                    if (error) {
                        const reason = sanitizeErrorCode(error);
                        return fail(400, `Authorization failed: ${reason}`, `OAuth authorization failed: ${reason}`);
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
            }
            catch (err) {
                bindFailed(err);
            }
        });
        // On a bind failure nobody holds `promise` yet — it is rejected before this function resolves,
        // which would surface as an unhandled rejection. The bind error reaches the caller through
        // bindFailed instead; a caller that DOES hold the listener still sees its own rejection.
        promise.catch(() => { });
        // listen() stands HERE, in the OUTER executor, on purpose: it validates its port synchronously
        // and throws a RangeError that is never delivered as an 'error' event, so only from here does
        // such a throw reject the Promise this function returns. From the inner executor it rejected
        // `promise` instead, which the catch above swallows — and this function stayed pending forever.
        try {
            server.listen(port);
        }
        catch {
            // Cleanup and wording only, NOT liveness: close() runs finish(), so a refused bind leaves
            // nothing behind, and node's own text names internals and no remedy, so it is replaced.
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
// Thrown by fetch, and by the body read, when the signal above fires: undici rejects with the
// signal's reason, and AbortSignal.timeout's reason is a DOMException named TimeoutError. Its own
// message ("The operation was aborted due to timeout") names no remedy, so it is replaced.
function isRequestTimeout(err) {
    return err instanceof Error && err.name === 'TimeoutError';
}
async function postToken(subdomain, body, fetchImpl, errorLabel) {
    // The signal bounds the WHOLE request, headers and body alike, so the body read stands inside the
    // same try: undici rejects `response.text()`/`.json()` with the same TimeoutError when the headers
    // arrive fast and the body stalls, and that raw DOMException names no field and no remedy.
    try {
        const response = await fetchImpl(`https://${subdomain}.zendesk.com/oauth/tokens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        });
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
    catch (err) {
        if (!isRequestTimeout(err))
            throw err;
        throw new Error(`${errorLabel}: no reply from the Zendesk token endpoint within ${TOKEN_REQUEST_TIMEOUT_MS / 1000} seconds — check the network connection, and any proxy or VPN between this machine and Zendesk.`);
    }
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
