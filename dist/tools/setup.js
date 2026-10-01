// src/tools/setup.ts
// First-run setup, served from the callback listener that already exists. It is a LOCAL PAGE and not
// a question in the chat for one reason: the client secret must never pass through the model or end
// up in a transcript. The MCP spec says so outright — "Servers MUST NOT use form mode elicitation to
// request sensitive information such as passwords, API keys, access tokens, or payment credentials."
//
// The page does two jobs in one visit: it names the exact place in the customer's own Zendesk where
// the OAuth client is created, and it collects the three values that come out of it. On success the
// browser is redirected straight on to the Zendesk authorization — the person is already in the right
// browser, with the right session, so this is a redirect and not a process launch (decision D3).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { MAX_SUBDOMAIN_LENGTH, validateSubdomain } from '../auth/config.js';
// Longer than the login window, because the human step is longer: this one includes creating an OAuth
// client in Zendesk Admin Center, reading two values off it and typing them. The login's 5 minutes
// bound "open a URL and approve"; 15 bounds "set up an integration".
export const SETUP_TIMEOUT_MS = 900_000;
// A form submission is a few hundred bytes. The cap is what stops an unauthenticated local process
// from making the server read until it runs out of memory — the body is read before the token is even
// checked, because the token for a POST arrives in the query string, not in the body.
const MAX_BODY_BYTES = 4096;
const HTML = { 'Content-Type': 'text/html; charset=utf-8' };
export function newSetupToken() {
    return randomBytes(32).toString('base64url');
}
// `host` is the address the listener REPORTED binding, never an assumption: `localhost` can resolve to a
// family this listener does not have, and a hardcoded 127.0.0.1 would hand the one-time token — and one
// form later the client secret — to whatever foreign process holds that address while the other family
// is ours. Measured: a foreign server on 127.0.0.1 with ::1 free received both.
export function setupUrl(host, port, token) {
    return `http://${host}:${port}/setup?t=${token}`;
}
// Length-independent comparison, so a wrong token cannot be found a character at a time. A local port
// makes that attack realistic rather than theoretical: there is no network round trip to hide in.
function tokenMatches(given, expected) {
    if (!given)
        return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}
// A request that SENDS an Origin must send this page's own — that is what stops a form on another site
// from posting to a loopback port it cannot read the answer from. A request that sends NONE is let
// through: `Origin` is a control a browser applies to itself, so its absence means the caller is not a
// browser, and against a non-browser caller the one-time token is the control, not a header that caller
// writes itself. Refusing it bought nothing and would have broken any client that omits the header.
function originAllowed(req, port) {
    const origin = req.headers.origin;
    if (typeof origin !== 'string')
        return true;
    return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin);
}
async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        // Dropped rather than answered: this is not a person pasting too much, it is a local caller making
        // the server read until it runs out of memory, and the cheapest true answer is to stop reading.
        if (size > MAX_BODY_BYTES) {
            req.destroy();
            throw new Error('setup form too large');
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}
// A fixed sentence per field, never the submitted value and never the exception's message: the rule
// for the subdomain interpolates the value it rejected, and this page does not echo what it was given.
const FIELD_PROBLEM = {
    ZENDESK_SUBDOMAIN: 'Die Subdomain besteht nur aus Buchstaben, Zahlen und Bindestrichen — für ' +
        `acme.zendesk.com ist der Wert „acme" (höchstens ${MAX_SUBDOMAIN_LENGTH} Zeichen).`,
    ZENDESK_OAUTH_CLIENT_ID: 'Die Client-ID fehlt oder enthält Zeichen, die dort nicht vorkommen.',
    ZENDESK_OAUTH_CLIENT_SECRET: 'Das Client-Secret fehlt oder enthält Zeichen, die dort nicht vorkommen.',
};
// Generous, because Zendesk's own lengths are not documented and a cap that is too tight rejects a
// legitimate credential. PRINTABLE ASCII only, which is more than tidiness: measured on macOS,
// `security find-generic-password -w` prints a password that is not plain ASCII as HEX, so a value with
// one accented character would be stored, read back mangled and authorize nothing, with no symptom
// pointing at the character. Control characters would additionally let one Keychain item look like
// several lines.
const MAX_FIELD_CHARS = 512;
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
function plainField(raw) {
    if (raw === null)
        return null;
    const value = raw.trim();
    if (!value || value.length > MAX_FIELD_CHARS || !PRINTABLE_ASCII.test(value))
        return null;
    return value;
}
// Returns the values, or the first field that is wrong. The subdomain goes through the resolver's own
// rule (src/auth/config.ts validateSubdomain): a value stored here that the next start would refuse
// is the one failure mode this page exists to prevent.
export function parseSetupForm(body) {
    const form = new URLSearchParams(body);
    const clientId = plainField(form.get('client_id'));
    const clientSecret = plainField(form.get('client_secret'));
    const rawSubdomain = plainField(form.get('subdomain'));
    let subdomain;
    try {
        subdomain = validateSubdomain(rawSubdomain ?? '');
    }
    catch {
        return { problem: 'ZENDESK_SUBDOMAIN' };
    }
    if (!clientId)
        return { problem: 'ZENDESK_OAUTH_CLIENT_ID' };
    if (!clientSecret)
        return { problem: 'ZENDESK_OAUTH_CLIENT_SECRET' };
    return {
        values: {
            ZENDESK_SUBDOMAIN: subdomain,
            ZENDESK_OAUTH_CLIENT_ID: clientId,
            ZENDESK_OAUTH_CLIENT_SECRET: clientSecret,
        },
    };
}
// Interpolates only values this process generated (the port and the one-time token, which is 32 random
// bytes base64url) plus one of the fixed sentences above — never anything the form submitted, which is
// why nothing here is escaped: there is no untrusted value to escape.
export function setupPage(port, token, problem) {
    const redirectUri = `http://localhost:${port}/callback`;
    const error = problem
        ? `<p class="error">${FIELD_PROBLEM[problem]} Bitte korrigieren und erneut absenden.</p>`
        : '';
    return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zendesk-Plugin einrichten</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0 auto; max-width: 42rem; padding: 1rem; }
label { display: block; margin-top: 1rem; }
.error { border-left: .25rem solid #c82828; padding-left: .75rem; }
</style>
</head>
<body>
<h1>Zendesk-Plugin einrichten</h1>
<p>Einmalig pro Zendesk-Instanz. Diese Seite läuft lokal auf diesem Rechner; die Werte verlassen ihn nicht und gehen nicht durch den Chat.</p>
${error}
<h2>1. OAuth-Client in Ihrem Zendesk anlegen</h2>
<p>Im Zendesk Admin Center: <strong>Apps und Integrationen → APIs → OAuth-Clients → „OAuth-Client hinzufügen"</strong>. Tragen Sie dort ein:</p>
<ul>
<li><strong>Weiterleitungs-URL:</strong> <code>${redirectUri}</code> — genau so, sonst weist Zendesk die Anmeldung ab.</li>
<li><strong>Art von Client:</strong> vertraulich (confidential).</li>
<li><strong>Zugriffsart:</strong> leer lassen. Leer bedeutet, dass alle Berechtigungen erlaubt sind; das Plugin fordert <code>read write</code> an.</li>
</ul>
<p class="note">Nach dem Speichern zeigt Zendesk das Client-Secret <strong>einmal</strong> an. Kopieren Sie es jetzt.</p>
<h2>2. Werte hier eintragen</h2>
<form method="post" action="/setup?t=${token}" autocomplete="off">
<label>Subdomain
<input name="subdomain" placeholder="acme" required autofocus spellcheck="false" autocapitalize="off">
</label>
<label>Eindeutige Kennung (Client-ID)
<input name="client_id" required spellcheck="false" autocapitalize="off">
</label>
<label>Client-Secret
<input name="client_secret" type="password" required spellcheck="false">
</label>
<button type="submit">Speichern und anmelden</button>
</form>
<p class="note">Beim Speichern geht es direkt weiter zur Zendesk-Anmeldung. Danach kann dieses Fenster geschlossen werden.</p>
</body>
</html>
`;
}
const answer = (status, body, headers = HTML) => ({
    status,
    headers,
    body,
});
// 404, not 403, for a bad token: an unauthenticated local caller learns nothing about whether a setup
// is pending. The page itself is the only thing that holds a valid one.
const notFound = () => answer(404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
export function createSetupRoute(deps) {
    // Single-use means a successful POST spends it. A failed one does not — otherwise one typo in the
    // subdomain would end the setup and the person would have to go back to the chat for a new URL —
    // and a GET does not either, so the page survives a reload. Neither discloses anything: the page is
    // instructions plus an empty form.
    let spent = false;
    // `spent` is checked BEFORE the body is read, and a body arrives in pieces: a client that has sent half
    // of it holds that await open, so a second POST starting meanwhile passed the same check and both
    // submitted. Measured, with nothing malicious in it — two 303s and two stored configurations from one
    // single-use token, leaving the flow pointed at whichever arrived last. So a POST that is already being
    // processed makes a second one a non-event. Released on a failure, which is what keeps a typo from
    // ending the setup.
    let submitting = false;
    return async (req, url) => {
        if (spent || !tokenMatches(url.searchParams.get('t'), deps.token))
            return notFound();
        if (req.method === 'GET')
            return answer(200, setupPage(deps.port, deps.token));
        // Nothing but GET and POST: the values are written on POST alone, so every other verb is a
        // caller that has misunderstood the page.
        if (req.method !== 'POST') {
            return answer(405, 'Use POST to submit the setup form.', {
                'Content-Type': 'text/plain; charset=utf-8',
                Allow: 'GET, POST',
            });
        }
        if (!originAllowed(req, deps.port)) {
            return answer(403, 'Diese Anfrage kam nicht von der Einrichtungsseite.');
        }
        if (submitting)
            return notFound();
        submitting = true;
        try {
            const parsed = parseSetupForm(await readBody(req));
            if ('problem' in parsed)
                return answer(400, setupPage(deps.port, deps.token, parsed.problem));
            // Stored first, redirected second: a redirect into an authorization whose client was not saved
            // would authorize a configuration the next start cannot reproduce.
            const authorizationUrl = deps.submit(parsed.values);
            spent = true;
            return answer(303, 'Weiter zur Zendesk-Anmeldung …', {
                'Content-Type': 'text/plain; charset=utf-8',
                Location: authorizationUrl,
            });
        }
        finally {
            submitting = false;
        }
    };
}
