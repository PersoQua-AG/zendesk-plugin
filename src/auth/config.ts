import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OAuthConfig } from './oauth-flow.js';

const DEFAULT_CALLBACK_PORT = 8976;
const DATA_DIR_NAME = 'zendesk-plugin';
const DEFAULT_SCOPES = ['read', 'write'];

// A Desktop Extension is unpacked into a versioned directory and its working directory is the
// host's, not the extension's — so a relative default would put tokens.enc somewhere arbitrary and
// lose it on update. Resolve an absolute per-user data dir instead. Platform/env are parameters so
// the resolution is testable without mutating the process.
export function defaultDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
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
} as const;

export const USER_CONFIG_FIELD_BY_ENV: Record<string, string> = USER_CONFIG_FIELDS;

// The MCPB host substitutes ${...} only for variables it has a value for; an optional user_config
// field the user left blank arrives as the LITERAL placeholder string
// (@anthropic-ai/mcpb@2.1.2 dist/shared/config.js:16-27). Dropping such values makes them "absent",
// so the shipped defaults apply instead of Number('${…}')===NaN or a literal directory name.
const PLACEHOLDER = /^\$\{[^}]*\}$/;

export function stripPlaceholders(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === 'string' && PLACEHOLDER.test(value)) delete out[key];
  }
  return out;
}

// A port a non-root process can actually be handed: below 1024 is privileged, above 65535 does not
// exist. The upper end matters most — server.listen() rejects it with a SYNCHRONOUS RangeError that
// no 'error' handler ever sees. Both manifests declare the same range as min/max on the
// oauth_callback_port field, so a compliant host refuses the value before the server is even started.
export const MIN_CALLBACK_PORT = 1024;
export const MAX_CALLBACK_PORT = 65535;

// One rule, one wording: stated here, reused verbatim by the callback listener in oauth-flow.ts for
// a port that reached it from somewhere other than this resolver.
export const CALLBACK_PORT_RULE =
  `extension configuration field "${USER_CONFIG_FIELDS.ZENDESK_OAUTH_CALLBACK_PORT}" must be a whole ` +
  `number between ${MIN_CALLBACK_PORT} and ${MAX_CALLBACK_PORT}`;

function isUsableCallbackPort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_CALLBACK_PORT && port <= MAX_CALLBACK_PORT;
}

// Rejected, never clamped. The port is half of the redirect_uri the user registered with Zendesk, so
// substituting a different one trades a loud startup error for an authorization that dies at
// Zendesk's redirect-mismatch check with nothing naming the cause. Port 0 is the sharpest case: it
// binds a RANDOM port while the URL still advertises :0/callback.
function callbackPort(env: NodeJS.ProcessEnv): number {
  // Falsy-coalesce, as below: '' and a stripped placeholder are "absent", not a value.
  const raw = env.ZENDESK_OAUTH_CALLBACK_PORT;
  if (!raw) return DEFAULT_CALLBACK_PORT;
  const port = Number(raw);
  if (!isUsableCallbackPort(port)) {
    throw new Error(`Invalid environment variable: ZENDESK_OAUTH_CALLBACK_PORT="${raw}" (${CALLBACK_PORT_RULE}).`);
  }
  return port;
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
//
// Two documented limits are deliberately NOT enforced, because neither protects anything here and
// both could lock out a real customer: the MINIMUM of 3 (it is stated for renaming, not as a
// property of every account that has ever existed — a grandfathered two-letter subdomain would be
// our bug, not their misconfiguration), and a leading/trailing dash (Zendesk states no such rule;
// such a name simply fails to resolve in DNS, which is a loud failure, not a redirected one).
export const MAX_SUBDOMAIN_LENGTH = 63;
const SUBDOMAIN_PATTERN = /^[a-z0-9-]+$/i;

// One rule, one wording — stated once here, the way CALLBACK_PORT_RULE is.
export const SUBDOMAIN_RULE =
  `extension configuration field "${USER_CONFIG_FIELDS.ZENDESK_SUBDOMAIN}" must be the subdomain by ` +
  `itself \u2014 letters, digits and dashes, at most ${MAX_SUBDOMAIN_LENGTH} characters; for ` +
  `acme.zendesk.com the value is "acme"`;

// Surrounding whitespace is a copy-paste artifact, not an opinion: trimmed, not rejected, because
// "acme " and "acme" are indistinguishable in the settings dialog that produced them.
function subdomain(env: NodeJS.ProcessEnv): string {
  const raw = required(env, 'ZENDESK_SUBDOMAIN').trim();
  if (!SUBDOMAIN_PATTERN.test(raw) || raw.length > MAX_SUBDOMAIN_LENGTH) {
    throw new Error(`Invalid environment variable: ZENDESK_SUBDOMAIN="${raw}" (${SUBDOMAIN_RULE}).`);
  }
  return raw;
}

export interface ResolvedAuthConfig {
  config: OAuthConfig;
  dataDir: string;
  tokensPath: string;
}

// Only an env var that HAS a user_config field may be required: the error names that field, and a
// name without one is a compile error here rather than a fallback that names the raw env var.
function required(env: NodeJS.ProcessEnv, name: keyof typeof USER_CONFIG_FIELDS): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name} (extension configuration field ` +
        `"${USER_CONFIG_FIELDS[name]}" is empty).`,
    );
  }
  return value;
}

// Single source of env resolution shared by server + authorize bin, so identical
// env yields an identical clientSecret + dataDir → identical TokenStore key/path.
export function resolveAuthConfig(rawEnv: NodeJS.ProcessEnv): ResolvedAuthConfig {
  const env = stripPlaceholders(rawEnv);
  // Falsy-coalesce (not ??): an empty-string env var is "absent", not a value.
  // Otherwise CLAUDE_PLUGIN_DATA='' → tokens.enc at the fs root, and
  // ZENDESK_OAUTH_CALLBACK_PORT='' → Number('')===0 → bind to port 0.
  const dataDir = env.CLAUDE_PLUGIN_DATA || defaultDataDir(env);
  return {
    config: {
      subdomain: subdomain(env),
      clientId: required(env, 'ZENDESK_OAUTH_CLIENT_ID'),
      clientSecret: required(env, 'ZENDESK_OAUTH_CLIENT_SECRET'),
      callbackPort: callbackPort(env),
      scopes: DEFAULT_SCOPES,
    },
    dataDir,
    // Single source of the token file location so server + authorize bin never drift. join(), not
    // a template literal: the manifest declares win32, where '/' would mix separators.
    tokensPath: join(dataDir, 'tokens.enc'),
  };
}
