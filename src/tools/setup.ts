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
import type { IncomingMessage } from 'node:http';
import type { SetupResponse, SetupRoute } from '../auth/oauth-flow.js';
import { MAX_SUBDOMAIN_LENGTH, validateSubdomain } from '../auth/config.js';

// Longer than the login window, because the human step is longer: this one includes creating an OAuth
// client in Zendesk Admin Center, reading two values off it and typing them. The login's 5 minutes
// bound "open a URL and approve"; 15 bounds "set up an integration".
export const SETUP_TIMEOUT_MS = 900_000;

// A form submission is a few hundred bytes. The cap is what stops an unauthenticated local process
// from making the server read until it runs out of memory — the body is read before the token is even
// checked, because the token for a POST arrives in the query string, not in the body.
const MAX_BODY_BYTES = 4096;

const HTML = { 'Content-Type': 'text/html; charset=utf-8' } as const;

// The three values, by the env var each one stands for — the same spelling src/auth/store-key.ts uses,
// so what the page collects and what the Keychain stores need no translation layer.
export interface SetupValues {
  ZENDESK_SUBDOMAIN: string;
  ZENDESK_OAUTH_CLIENT_ID: string;
  ZENDESK_OAUTH_CLIENT_SECRET: string;
}

export function newSetupToken(): string {
  return randomBytes(32).toString('base64url');
}

// 127.0.0.1 rather than localhost: the browser must reach THIS listener, and `localhost` can resolve
// to a family the listener may not have (one of the two binds is allowed to fail, oauth-flow.ts).
export function setupUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/setup?t=${token}`;
}

// Length-independent comparison, so a wrong token cannot be found a character at a time. A local port
// makes that attack realistic rather than theoretical: there is no network round trip to hide in.
function tokenMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Only this page's own origin may POST here. A form on any other site can POST to a loopback port
// without reading the answer, and the body of this one carries a client secret. A request with NO
// Origin is refused too: every current browser sends one on a form POST, so its absence is not a
// browser form.
function originAllowed(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((done, failed) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        failed(new Error('setup form too large'));
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => done(body));
    req.on('error', (err) => failed(err));
  });
}

// A fixed sentence per field, never the submitted value and never the exception's message: the rule
// for the subdomain interpolates the value it rejected, and this page does not echo what it was given.
const FIELD_PROBLEM: Record<keyof SetupValues, string> = {
  ZENDESK_SUBDOMAIN: 'Die Subdomain besteht nur aus Buchstaben, Zahlen und Bindestrichen — für ' +
    `acme.zendesk.com ist der Wert „acme" (höchstens ${MAX_SUBDOMAIN_LENGTH} Zeichen).`,
  ZENDESK_OAUTH_CLIENT_ID: 'Die Client-ID fehlt oder enthält Zeichen, die dort nicht vorkommen.',
  ZENDESK_OAUTH_CLIENT_SECRET: 'Das Client-Secret fehlt oder enthält Zeichen, die dort nicht vorkommen.',
};

// Generous, because Zendesk's own lengths are not documented and a cap that is too tight rejects a
// legitimate credential. Control characters are refused outright: they belong in no OAuth value, and
// they are what would let one line of a Keychain item look like several.
const MAX_FIELD_CHARS = 512;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function plainField(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (!value || value.length > MAX_FIELD_CHARS || CONTROL_CHARS.test(value)) return null;
  return value;
}

// Returns the values, or the first field that is wrong. The subdomain goes through the resolver's own
// rule (src/auth/config.ts validateSubdomain): a value stored here that the next start would refuse
// is the one failure mode this page exists to prevent.
export function parseSetupForm(body: string): { values: SetupValues } | { problem: keyof SetupValues } {
  const form = new URLSearchParams(body);
  const clientId = plainField(form.get('client_id'));
  const clientSecret = plainField(form.get('client_secret'));
  const rawSubdomain = plainField(form.get('subdomain'));
  let subdomain: string;
  try {
    subdomain = validateSubdomain(rawSubdomain ?? '');
  } catch {
    return { problem: 'ZENDESK_SUBDOMAIN' };
  }
  if (!clientId) return { problem: 'ZENDESK_OAUTH_CLIENT_ID' };
  if (!clientSecret) return { problem: 'ZENDESK_OAUTH_CLIENT_SECRET' };
  return {
    values: {
      ZENDESK_SUBDOMAIN: subdomain,
      ZENDESK_OAUTH_CLIENT_ID: clientId,
      ZENDESK_OAUTH_CLIENT_SECRET: clientSecret,
    },
  };
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Interpolates only values this process generated (the port and the one-time token) plus one of the
// fixed sentences above — never anything the form submitted.
export function setupPage(port: number, token: string, problem?: keyof SetupValues): string {
  const redirectUri = `http://localhost:${port}/callback`;
  const error = problem
    ? `<p class="error">${escapeHtml(FIELD_PROBLEM[problem])} Bitte korrigieren und erneut absenden.</p>`
    : '';
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zendesk-Plugin einrichten</title>
<style>
:root { color-scheme: light dark; }
body { font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0 auto; max-width: 42rem; padding: 2rem 1rem 4rem; }
h1 { font-size: 1.5rem; margin-bottom: .25rem; }
h2 { font-size: 1.1rem; margin-top: 2rem; }
ol, ul { padding-left: 1.25rem; }
li { margin: .4rem 0; }
code { background: rgba(127,127,127,.18); border-radius: .25rem; padding: .1rem .3rem; }
label { display: block; font-weight: 600; margin-top: 1rem; }
input { box-sizing: border-box; font: inherit; margin-top: .3rem; padding: .5rem; width: 100%; }
button { font: inherit; font-weight: 600; margin-top: 1.5rem; padding: .6rem 1.2rem; }
.error { background: rgba(200,40,40,.14); border-left: .25rem solid #c82828; padding: .75rem; }
.note { opacity: .8; font-size: .9rem; }
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
<form method="post" action="/setup?t=${escapeHtml(token)}" autocomplete="off">
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

export interface SetupRouteDeps {
  port: number;
  token: string;
  // Stores the values and returns the URL the browser is sent on to — the Zendesk authorization. It
  // throws if the values cannot be stored, and then nothing is redirected anywhere.
  submit: (values: SetupValues) => string;
}

const answer = (status: number, body: string, headers: Record<string, string> = HTML): SetupResponse => ({
  status,
  headers,
  body,
});

// 404, not 403, for a bad token: an unauthenticated local caller learns nothing about whether a setup
// is pending. The page itself is the only thing that holds a valid one.
const notFound = (): SetupResponse => answer(404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });

export function createSetupRoute(deps: SetupRouteDeps): SetupRoute {
  // Single-use means a successful POST spends it. A failed one does not — otherwise one typo in the
  // subdomain would end the setup and the person would have to go back to the chat for a new URL —
  // and a GET does not either, so the page survives a reload. Neither discloses anything: the page is
  // instructions plus an empty form.
  let spent = false;

  return {
    handle: async (req, url): Promise<SetupResponse> => {
      if (spent || !tokenMatches(url.searchParams.get('t'), deps.token)) return notFound();
      if (req.method === 'GET') return answer(200, setupPage(deps.port, deps.token));
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

      const parsed = parseSetupForm(await readBody(req));
      if ('problem' in parsed) return answer(400, setupPage(deps.port, deps.token, parsed.problem));

      // Stored first, redirected second: a redirect into an authorization whose client was not saved
      // would authorize a configuration the next start cannot reproduce.
      const authorizationUrl = deps.submit(parsed.values);
      spent = true;
      return answer(303, 'Weiter zur Zendesk-Anmeldung …', {
        'Content-Type': 'text/plain; charset=utf-8',
        Location: authorizationUrl,
      });
    },
  };
}
