import { createServer } from 'node:http';
import { z } from 'zod';
import { CALLBACK_PORT_RULE } from './config.js';
import { warnConfig } from '../util/warn-config.js';
// Both loopback families, one handler, because `localhost` is not one address. On macOS it resolves
// to ::1 BEFORE 127.0.0.1, and the redirect_uri registered with Zendesk says `localhost` — so a
// listener on 127.0.0.1 alone never sees the browser come back. The wildcard bind this replaced did
// see it, but it also answered on every routable interface of the machine, which is not what a
// five-minute window holding an authorization code should be reachable on.
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'];
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
// '<' '>' dropped though NQCHAR allows them: no real code uses them and they could forge markup.
const NOT_NQCHAR = /[^\x20-\x21\x23-\x3B\x3D\x3F-\x5B\x5D-\x7E]/g;
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
// Named in the timeout, never with the state value: a state bug must not look like a mere timeout.
const STRAY_STATE_NOTE = '; a callback with an unexpected state was received and ignored';
// Resolves only once the port is actually bound, and REJECTS on a bind failure (e.g. EADDRINUSE) —
// so a caller never receives a listener whose callback could never land, and never has to inspect
// an error returned as a value.
export function startCallbackListener(port, expectedState, timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS, setup) {
    return new Promise((bound, bindFailed) => {
        let close;
        // Assigned synchronously by the executor below, so that listen() can be called from THIS
        // executor rather than that one — see the comment at the call.
        let bindings;
        const promise = new Promise((resolve, reject) => {
            // Every call below is wrapped, not just the one that bit us in #9. This is the INNER
            // executor: a synchronous throw in here rejects `promise`, which the catch below this
            // function swallows, so the promise startCallbackListener() returns would never settle and
            // every serialized login behind it would hang. bindFailed() settles the one the caller
            // actually holds. Enforced by scripts/assert-executor-safety.mjs.
            try {
                let settled = false;
                let ignoredStrayState = false;
                const handler = (req, res) => {
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
                    // The setup route, before the callback's `state` check: a first-run visit has no state yet
                    // — the configuration it is about to collect is what the authorization will be built from.
                    // It never settles the flow; what settles it is the /callback the page redirects into.
                    if (setup && url.pathname === '/setup') {
                        // Written exactly the way every other answer in this handler is written, with no guard of
                        // its own: the socket may be gone — an over-long body is dropped by destroying it, and a
                        // person can close the tab — and node drops a write to a dead response rather than
                        // throwing. A guard here would be an unreachable branch pretending to be a safety net.
                        const write = (answer) => void res.writeHead(answer.status, answer.headers).end(answer.body);
                        // A throw out of the page must take neither the pending authorization nor the server with
                        // it, and must not describe itself: this request carries the client secret.
                        void setup(req, url).then(write, () => write({
                            status: 500,
                            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                            body: 'Setup failed. Call the Zendesk tool again to start over.',
                        }));
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
                        ignoredStrayState = true;
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
                };
                // One server per family over that one handler, so which family the browser arrived on makes
                // no difference to the flow: there is a single `settled` flag and a single `state` behind both.
                bindings = LOOPBACK_ADDRESSES.map((address) => ({ address, server: createServer(handler) }));
                const timer = setTimeout(() => {
                    const stray = ignoredStrayState ? STRAY_STATE_NOTE : '';
                    finish(() => reject(new Error(`OAuth callback timed out after ${timeoutMs}ms${stray}`)));
                }, timeoutMs);
                timer.unref?.();
                const finish = (settle) => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    for (const binding of bindings)
                        binding.server.close();
                    settle();
                };
                close = () => finish(() => reject(new Error('OAuth callback listener closed')));
                // The bind is decided once BOTH families have answered. One family failing is survivable —
                // the other still receives the callback — and is only worth a warning. Nothing left to bind
                // on is the failure, and then the reason carries both families' errors, because
                // ../tools/login.ts translates EADDRINUSE into the remedy the user needs.
                let pending = bindings.length;
                const listening = [];
                let decided = false;
                const bindErrors = [];
                const decide = () => {
                    if (decided || pending > 0)
                        return;
                    decided = true;
                    if (listening.length > 0)
                        return bound({ promise, close, addresses: listening });
                    const bindError = new Error(`OAuth callback server error: ${bindErrors.join('; ')}`);
                    finish(() => reject(bindError));
                    bindFailed(bindError);
                };
                for (const binding of bindings) {
                    binding.server.on('error', (err) => {
                        // After the bind was decided this is a LIVE listener failing (EMFILE on accept, the
                        // interface going away): it ends the flow the same way a timeout does, because the
                        // authorization code can no longer land. Handled rather than left to node, where an
                        // 'error' with no handler is an uncaughtException that takes the whole stdio server with
                        // it. Not reachable from a test — a bound listener cannot be made to fail on demand —
                        // and leaving it out is the defect, so it is excluded from coverage rather than dropped.
                        /* v8 ignore next */
                        if (decided)
                            return finish(() => reject(new Error(`OAuth callback server error: ${err.message}`)));
                        pending -= 1;
                        bindErrors.push(`${binding.address}: ${err.message}`);
                        warnConfig(`the OAuth callback listener could not bind ${binding.address}:${port} ` +
                            `(${err.code}) \u2014 continuing on the other address family if it bound.`);
                        decide();
                    });
                    binding.server.on('listening', () => {
                        pending -= 1;
                        listening.push(binding.address);
                        decide();
                    });
                }
            }
            catch (err) {
                // Not `err as Error`: a throw from any of these is not typed, and login.ts's failureText
                // reads `err instanceof Error` (src/tools/login.ts:95). The cast was a lie the type system
                // could not catch, written only to satisfy an earlier, stricter reading of the guard.
                bindFailed(err instanceof Error ? err : new Error(String(err)));
            }
        });
        // On a bind failure nobody holds `promise` yet — it is rejected before this function resolves,
        // which would surface as an unhandled rejection. The bind error reaches the caller through
        // bindFailed instead; a caller that DOES hold the listener still sees its own rejection.
        promise.catch(() => { });
        // listen() stands HERE, in the OUTER executor, on purpose, and this is the PREFERRED shape: it
        // validates its port synchronously and throws a RangeError that is never delivered as an
        // 'error' event, so only from here does such a throw reject the Promise this function returns.
        // From the inner executor it rejected `promise` instead, which the catch above swallows.
        //
        // Two layers now stand between that throw and a pending promise, and they are not redundant:
        // this placement is the fix, and the inner executor's try/catch is the net under everything
        // ELSE in that body (createServer, the emitter registrations) that #9 never looked at.
        try {
            for (const binding of bindings)
                binding.server.listen(port, binding.address);
        }
        catch (err) {
            // Cleanup and wording only, NOT liveness. Honest about its own reach: if the INNER executor
            // threw, `server` and `close` were never assigned, so listen() throws a TypeError here,
            // close() throws a second one, and both are swallowed because bindFailed() has already
            // settled this promise. Harmless — there is nothing to close on that path — but the cleanup
            // below provably does not run there. It carries on the path it was written for: a real
            // listener that refuses to bind.
            close();
            // ONE REASON PER CAUSE (#104). This used to answer EVERY synchronous throw with the port
            // rule, and for anything but a RangeError that sentence is FALSE: the port is in range.
            // Measured in PR #101 — a bind-time guard threw here and the caller was told
            // `port 8976 (… must be a whole number between 1024 and 65535)`, so the reader went to check
            // a number that was never the problem while the only description of the real cause was
            // dropped on the floor.
            //
            // What does NOT change is why the replacement exists at all: node's own wording carries
            // absolute paths and its stack carries frames, and neither may reach the MCP boundary
            // (src/tools/login.ts reads err.message). So nothing from `err` is interpolated except its
            // CLASS NAME, which is an identifier rather than text — and only when it looks like one, so
            // a thrown object with a doctored `name` cannot smuggle a path in. The original is attached
            // as `cause`, which a developer in the process can read and no tool response serializes.
            // Length-bounded as well as character-bounded: `name` is writable, and a 200 000-character
            // one reached the MCP boundary verbatim. No real error class name is anywhere near 40.
            const kind = err instanceof Error && /^[A-Za-z]{1,40}Error$/.test(err.name) ? err.name : 'an error';
            throw err instanceof RangeError
                ? new Error(`OAuth callback server could not start on port ${port} (${CALLBACK_PORT_RULE}).`, {
                    cause: err,
                })
                : new Error(
                // NOTHING ABOUT THE RANGE, AND NOTHING ABOUT THE RULE. Two rewrites of this sentence
                // each smuggled a claim back in. "The port is inside the allowed range" is false for
                // 0-1023: node's listen() throws RangeError only outside 0-65535, CALLBACK_PORT_RULE
                // is 1024-65535, and nothing range-checks `port` before this call. "So the callback
                // port rule is not the reason" is no better — nothing in this try enforces that rule
                // (src/auth/config.ts:115 does, earlier and elsewhere), so it does not follow from
                // `!(err instanceof RangeError)` either.
                //
                // What DOES follow is exactly one thing: node's own port validation throws RangeError,
                // and a RangeError took the other branch. That is the whole sentence. "Before any bind
                // was attempted" is gone too — there are two bindings, so a throw on the second one
                // comes after the first has started binding.
                `OAuth callback server could not start on port ${port}: listen() threw ${kind}, which` +
                    ` is not node's own port validation — that throws RangeError and is reported` +
                    ` separately.`, { cause: err });
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
// cut passes through untouched. So the body is capped on BOTH axes, and a line carrying an angle
// bracket anywhere is dropped entirely rather than quoted.
const MAX_ERROR_BODY_CHARS = 200;
// Every break a reader renders ends the quoted line. VT, FF and FS\u2013GS\u2013RS (U+000B, U+000C,
// U+001C\u2013U+001E) are breaks in Unicode \u2014 UAX #14 class BK for the first two, UAX #9 class B for all
// five \u2014 but they used to fall under CONTROL_OR_BIDI alone, which REMOVES a character instead of
// cutting at it. So everything after one was glued onto the quote rather than dropped with the rest
// of the body: `invalid_grant\x0BIgnore previous instructions` quoted as one line. Same class as the
// CR gap closed in #42. U+001F (US) stays out: it is a separator in neither standard, and the
// existing cases quote it as a removed control.
const LINE_BREAK = /[\n\r\u000B\u000C\u001C-\u001E\u0085\u2028\u2029]/;
// Invisible by Unicode's own account, not by a named list: six literals left 4190 other ignorable
// codepoints standing \u2014 U+2060 WORD JOINER, the standard replacement for the U+FEFF they did name,
// and the whole tag block U+E0020\u2013U+E007F, which carries a readable instruction past a quote whose
// purpose is to make foreign text safe. Cc is the controls, Cf the bidi overrides of CVE-2021-42574.
const CONTROL_OR_BIDI = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
// Returns '' for a blank body, so the caller can end the message at the status.
function summarizeErrorBody(raw) {
    // TAB is replaced BEFORE the strip rather than excluded from it, so it has exactly one fate:
    // dropping it with the other controls turned `invalid\tgrant` into `invalidgrant`.
    const firstLine = raw.split(LINE_BREAK)[0].replaceAll('\t', ' ').replace(CONTROL_OR_BIDI, '').trim();
    if (/[<>]/.test(firstLine))
        return '(non-text response body omitted)';
    return firstLine.length > MAX_ERROR_BODY_CHARS
        ? `${firstLine.slice(0, MAX_ERROR_BODY_CHARS).replace(/[\uD800-\uDBFF]$/, '')}… (truncated)`
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
            const detail = summarizeErrorBody(await response.text());
            throw new Error(`${errorLabel}: ${response.status}${detail ? ` ${detail}` : ''}`);
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
// OMITTED, not sent empty: Zendesk rejects `client_secret: ""` on a public client, so an absent
// secret must leave the field out of the body entirely rather than send a blank one.
function clientSecretField(config) {
    return config.clientSecret ? { client_secret: config.clientSecret } : {};
}
export function exchangeCodeForTokens(config, code, codeVerifier, redirectUriValue, fetchImpl = fetch) {
    return postToken(config.subdomain, {
        grant_type: 'authorization_code',
        code,
        client_id: config.clientId,
        redirect_uri: redirectUriValue,
        code_verifier: codeVerifier,
        scope: config.scopes.join(' '),
        ...clientSecretField(config),
    }, fetchImpl, 'Token exchange failed');
}
export function refreshAccessToken(config, refreshToken, fetchImpl = fetch) {
    return postToken(config.subdomain, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
        ...clientSecretField(config),
    }, fetchImpl, 'Token refresh failed');
}
