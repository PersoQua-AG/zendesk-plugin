import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CONFIG_ACCOUNTS, readKeychainConfig, resolveTokenStoreKey, runSecurity, } from './store-key.js';
export const DEFAULT_CALLBACK_PORT = 8976;
const DATA_DIR_NAME = 'zendesk-plugin';
// Exported because the first-run setup page states which scopes the plugin asks for, and an incomplete
// start still has to carry them into the authorization the page continues into.
export const DEFAULT_SCOPES = ['read', 'write'];
// A Desktop Extension is unpacked into a versioned directory and its working directory is the
// host's, not the extension's — so a relative default would put tokens.enc somewhere arbitrary and
// lose it on update. Resolve an absolute per-user data dir instead. Platform/env are parameters so
// the resolution is testable without mutating the process.
export function defaultDataDir(env = process.env, platform = process.platform) {
    if (platform === 'win32') {
        return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), DATA_DIR_NAME);
    }
    if (platform === 'darwin') {
        return join(homedir(), 'Library', 'Application Support', DATA_DIR_NAME);
    }
    return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), DATA_DIR_NAME);
}
// Every env var the extension/plugin manifests feed from a user_config field, so an error can name
// the field the user must fill in rather than an env var they never see. Also the sync source the
// manifest test checks both manifests against.
const USER_CONFIG_FIELDS = {
    ZENDESK_SUBDOMAIN: 'zendesk_subdomain',
    ZENDESK_OAUTH_CLIENT_ID: 'oauth_client_id',
    ZENDESK_OAUTH_CLIENT_SECRET: 'oauth_client_secret',
    ZENDESK_OAUTH_CALLBACK_PORT: 'oauth_callback_port',
    ZENDESK_SECURITY_LEVEL: 'security_level',
    ZENDESK_MARKDOWN_CONVERSION: 'markdown_conversion',
    ZENDESK_TIMEZONE: 'timezone',
    ZENDESK_WORK_HOURS: 'work_hours',
    ZENDESK_WORKDAYS: 'workdays',
};
export const USER_CONFIG_FIELD_BY_ENV = USER_CONFIG_FIELDS;
// The MCPB host substitutes ${...} only for variables it has a value for; an optional user_config
// field the user left blank arrives as the LITERAL placeholder string
// (@anthropic-ai/mcpb@2.1.2 dist/shared/config.js:16-27). Dropping such values makes them "absent",
// so the shipped defaults apply instead of Number('${…}')===NaN or a literal directory name.
const PLACEHOLDER = /^\$\{[^}]*\}$/;
// Exported because zendesk_diagnostics reports the substitution state of ${CLAUDE_PLUGIN_ROOT} and
// ${CLAUDE_PLUGIN_DATA}, and that question has to be asked of the RAW env with this same rule.
export function isPlaceholder(value) {
    return typeof value === 'string' && PLACEHOLDER.test(value);
}
export function stripPlaceholders(env) {
    const out = { ...env };
    for (const [key, value] of Object.entries(out)) {
        if (isPlaceholder(value))
            delete out[key];
    }
    return out;
}
// A relative CLAUDE_PLUGIN_DATA is never used as given: the host's working directory is not the
// extension's, so "data" would put tokens.enc and the cache wherever the server happened to be
// started and lose both on the next launch. resolveAuthConfig REJECTS such a value (loudly, naming
// the variable); this resolver is what the degraded startup path falls back to, where there is
// nothing left to reject into.
export function dataDirOf(env) {
    // Falsy-coalesce, not ??: an empty-string value is "absent", not a value.
    const raw = env.CLAUDE_PLUGIN_DATA;
    return raw && isAbsolute(raw) ? raw : defaultDataDir(env);
}
// A port a non-root process can actually be handed: below 1024 is privileged, above 65535 does not
// exist. The upper end matters most — server.listen() rejects it with a SYNCHRONOUS RangeError that
// no 'error' handler ever sees. Both manifests declare the same range as min/max on the
// oauth_callback_port field, so a compliant host refuses the value before the server is even started.
export const MIN_CALLBACK_PORT = 1024;
export const MAX_CALLBACK_PORT = 65535;
// One rule, one wording: stated here, reused verbatim by the callback listener in oauth-flow.ts for
// a port that reached it from somewhere other than this resolver.
export const CALLBACK_PORT_RULE = `extension configuration field "${USER_CONFIG_FIELDS.ZENDESK_OAUTH_CALLBACK_PORT}" must be a whole ` +
    `number between ${MIN_CALLBACK_PORT} and ${MAX_CALLBACK_PORT}`;
// Rejected, never clamped. The port is half of the redirect_uri the user registered with Zendesk, so
// substituting a different one trades a loud startup error for an authorization that dies at
// Zendesk's redirect-mismatch check with nothing naming the cause. Port 0 is the sharpest case: it
// binds a RANDOM port while the URL still advertises :0/callback.
function callbackPort(env) {
    // Falsy-coalesce, as below: '' and a stripped placeholder are "absent", not a value.
    const raw = env.ZENDESK_OAUTH_CALLBACK_PORT;
    if (!raw)
        return DEFAULT_CALLBACK_PORT;
    const port = Number(raw);
    if (!Number.isInteger(port) || port < MIN_CALLBACK_PORT || port > MAX_CALLBACK_PORT) {
        throw new Error(`Invalid environment variable: ZENDESK_OAUTH_CALLBACK_PORT="${raw}" (${CALLBACK_PORT_RULE}).`);
    }
    return port;
}
// The port for a start that could not resolve the rest, and the PROBLEM when the configured one is
// unusable — because the reason resolveAuthConfig threw with is almost never about the port: the subdomain
// is validated first, so a start with both a missing subdomain and a port of 70000 reported only the
// subdomain. The person then registered http://localhost:8976/callback in Zendesk on the page's word,
// finished setup, and the NEXT start threw on the port. So the problem travels with the fallback and the
// caller puts it where the person will read it.
export function callbackPortOrDefault(env) {
    try {
        return { port: callbackPort(env) };
    }
    catch (err) {
        // `err as Error` is honest here and only here: the single thrower is callbackPort, two lines up, and it
        // throws an Error carrying the field and the value. (oauth-flow.ts:226 refuses the same cast for the
        // opposite reason — there the throw can come from anywhere.)
        const problem = err.message.split('\n')[0];
        return {
            port: DEFAULT_CALLBACK_PORT,
            problem: `${problem} Port ${DEFAULT_CALLBACK_PORT} is being used until that is corrected \u2014 register the redirect URL for the port you finally keep.`,
        };
    }
}
// The subdomain is interpolated into every Zendesk URL this plugin builds (oauth-flow.ts:48/:210,
// http-client.ts:32, remote/zendesk-identity.ts:15). Unvalidated it does not merely produce a broken
// URL, it RELOCATES one: new URL(`https://${s}.zendesk.com/oauth/tokens`) has origin
// https://evil.example.com for s="evil.example.com/x", and the same for a '#', a '?' or an '@'
// (userinfo). That POST carries client_id, client_secret and refresh_token in its body, so a moved
// host is disclosure of secrets, not a failed request. The value is NOT attacker-supplied — it comes
// from the local configuration dialog — so this guards a copy-paste (an instruction, a support
// ticket, a shared setup snippet), and a copy-paste would hand the secrets over just as completely.
//
// The rule is Zendesk's own documented character set, not a tighter invention: a subdomain "can
// include only letters A-Z, numbers 0-9, and dashes (-)" — "You can't use underscores (_) or other
// special characters" — with "between 3 and 63 characters" (Zendesk help, "Renaming your
// subdomain", support.zendesk.com/hc/en-us/articles/4408845973914). None of those characters carries
// meaning in a URL authority, so the character set alone is what closes the hole; 63 is also the
// hard DNS label limit (RFC 1035 §2.3.4), so a longer value could never resolve.
export const MAX_SUBDOMAIN_LENGTH = 63;
const SUBDOMAIN_PATTERN = /^[a-z0-9-]+$/i;
// One rule, one wording — stated once here, the way CALLBACK_PORT_RULE is.
export const SUBDOMAIN_RULE = `extension configuration field "${USER_CONFIG_FIELDS.ZENDESK_SUBDOMAIN}" must be the subdomain by ` +
    `itself \u2014 letters, digits and dashes, at most ${MAX_SUBDOMAIN_LENGTH} characters; for ` +
    `acme.zendesk.com the value is "acme"`;
// The second wording, for a value that satisfies the rule above and still is not a host name.
const SUBDOMAIN_NOT_A_HOST_RULE = `extension configuration field "${USER_CONFIG_FIELDS.ZENDESK_SUBDOMAIN}" is not a usable host ` +
    `name \u2014 a value starting with "xn--" is an internationalized-domain prefix and this one does ` +
    `not decode; for acme.zendesk.com the value is "acme"`;
// Surrounding whitespace is a copy-paste artifact, not an opinion: trimmed, not rejected, because
// "acme " and "acme" are indistinguishable in the settings dialog that produced them.
function subdomain(env) {
    return validateSubdomain(required(env, 'ZENDESK_SUBDOMAIN'));
}
// Exported because the first-run setup page takes the same value from a form, and a value that this
// resolver would refuse must be refused THERE, where the person can still correct it — not stored and
// then rejected at the next start. One rule, one implementation.
export function validateSubdomain(value) {
    const raw = value.trim();
    if (!SUBDOMAIN_PATTERN.test(raw) || raw.length > MAX_SUBDOMAIN_LENGTH) {
        throw new Error(`Invalid environment variable: ZENDESK_SUBDOMAIN="${raw}" (${SUBDOMAIN_RULE}).`);
    }
    // A value can pass the character set above and still not be a host name. An `xn--` prefix marks an
    // internationalized (punycode) label, and new URL() applies IDNA to it: measured on node v24,
    // "xn--", "xn--a" and "xn--1" all throw `Invalid URL`, while a REAL one resolves
    // ("xn--bcher-kva" -> https://xn--bcher-kva.zendesk.com, b\u00fccher). Checked by FORMING the URL
    // rather than by refusing the prefix, for exactly that reason: the prefix is legitimate and a
    // customer could hold one, only some of its payloads are not, and forming the URL states the
    // property instead of guessing which payloads those are.
    //
    // Not an origin defect \u2014 the character set already closed that hole \u2014 but a message one.
    // Unchecked, the value reaches buildAuthorizationUrl (oauth-flow.ts:48) and the user is told
    // "Zendesk login failed: Invalid URL. Run zendesk_login again once that is resolved."
    // (../tools/login.ts:133): no field named, and a retry that can never succeed. Here it fails at
    // startup, in the field that has to change.
    try {
        new URL(`https://${raw}.zendesk.com`);
    }
    catch {
        throw new Error(`Invalid environment variable: ZENDESK_SUBDOMAIN="${raw}" (${SUBDOMAIN_NOT_A_HOST_RULE}).`);
    }
    return raw;
}
// Env WINS, the Keychain fills the gaps: an install that passes everything through the environment
// (Claude Code as it works today) behaves exactly as it did, and — because the Keychain is read only
// when something is actually missing — never touches it at all, so it cannot be broken by a locked one
// either. A Keychain that cannot be read throws rather than reading as empty: see readKeychainConfig.
function withKeychainConfig(env, security) {
    const missing = Object.keys(CONFIG_ACCOUNTS).filter((name) => !env[name]);
    if (missing.length === 0)
        return env;
    const stored = readKeychainConfig(security);
    const filled = { ...env };
    for (const name of missing) {
        const value = stored[name];
        // A STORED value that the rule below would refuse is dropped rather than carried forward, for two
        // reasons. It must not reach the error message: that message is tool output, and the owner decided
        // the customer's instance name is not to lie around in the open. And dropping it makes the
        // configuration incomplete again, which is what gets the setup page offered instead of a start that
        // fails on a value nobody can see or correct.
        if (!value || (name === 'ZENDESK_SUBDOMAIN' && !isUsableSubdomain(value)))
            continue;
        filled[name] = value;
    }
    return filled;
}
function isUsableSubdomain(value) {
    try {
        validateSubdomain(value);
        return true;
    }
    catch {
        return false;
    }
}
// Only an env var that HAS a user_config field may be required: the error names that field, and a
// name without one is a compile error here rather than a fallback that names the raw env var.
function required(env, name) {
    const value = env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name} (extension configuration field ` +
            `"${USER_CONFIG_FIELDS[name]}" is empty).`);
    }
    return value;
}
// Single source of env resolution shared by server + authorize bin, so identical env yields an
// identical dataDir → an identical tokens.enc path, and one and the same Keychain key opens it. The
// key is no longer derived from the client secret, so rotating the secret leaves the store readable.
//
// `security` is a parameter for the same reason env/platform are parameters on defaultDataDir: ONE seam
// for the whole Keychain path — the key and the three values — so the real logic in ./store-key.ts runs
// under test rather than being stubbed out, and no suite reaches a real login keychain.
export function resolveAuthConfig(rawEnv, security = runSecurity) {
    const env = withKeychainConfig(stripPlaceholders(rawEnv), security);
    // Falsy-coalesce (not ??): an empty-string env var is "absent", not a value.
    // Otherwise CLAUDE_PLUGIN_DATA='' → tokens.enc at the fs root, and
    // ZENDESK_OAUTH_CALLBACK_PORT='' → Number('')===0 → bind to port 0.
    const raw = env.CLAUDE_PLUGIN_DATA;
    if (raw && !isAbsolute(raw)) {
        throw new Error(`Invalid environment variable: CLAUDE_PLUGIN_DATA="${raw}" (must be an absolute path \u2014 a ` +
            'relative one places tokens.enc under whatever working directory the host started the server in).');
    }
    const dataDir = raw || defaultDataDir(env);
    let storeKey;
    return {
        config: {
            subdomain: subdomain(env),
            clientId: required(env, 'ZENDESK_OAUTH_CLIENT_ID'),
            // Optional since #68: a public OAuth client has no secret, and PKCE is what authenticates the
            // exchange. Sent when configured (every existing install and the CLI), omitted when not.
            clientSecret: env.ZENDESK_OAUTH_CLIENT_SECRET || undefined,
            callbackPort: callbackPort(env),
            scopes: DEFAULT_SCOPES,
        },
        dataDir,
        // Memoized: one `security` invocation per process, however many readers there are.
        get tokenStoreKey() {
            return (storeKey ??= resolveTokenStoreKey(security));
        },
        // Single source of the token file location so server + authorize bin never drift. join(), not
        // a template literal: the manifest declares win32, where '/' would mix separators.
        tokensPath: join(dataDir, 'tokens.enc'),
    };
}
