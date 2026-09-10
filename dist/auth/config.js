import { homedir } from 'node:os';
import { join } from 'node:path';
const DEFAULT_CALLBACK_PORT = 8976;
const DATA_DIR_NAME = 'zendesk-plugin';
const DEFAULT_SCOPES = ['read', 'write'];
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
export const USER_CONFIG_FIELD_BY_ENV = {
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
// The MCPB host substitutes ${...} only for variables it has a value for; an optional user_config
// field the user left blank arrives as the LITERAL placeholder string
// (@anthropic-ai/mcpb@2.1.2 dist/shared/config.js:16-27). Dropping such values makes them "absent",
// so the shipped defaults apply instead of Number('${…}')===NaN or a literal directory name.
const PLACEHOLDER = /^\$\{[^}]*\}$/;
export function stripPlaceholders(env) {
    const out = { ...env };
    for (const [key, value] of Object.entries(out)) {
        if (typeof value === 'string' && PLACEHOLDER.test(value))
            delete out[key];
    }
    return out;
}
function required(env, name) {
    const value = env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name} (extension configuration field ` +
            `"${USER_CONFIG_FIELD_BY_ENV[name] ?? name}" is empty).`);
    }
    return value;
}
// Single source of env resolution shared by server + authorize bin, so identical
// env yields an identical clientSecret + dataDir → identical TokenStore key/path.
export function resolveAuthConfig(rawEnv) {
    const env = stripPlaceholders(rawEnv);
    // Falsy-coalesce (not ??): an empty-string env var is "absent", not a value.
    // Otherwise CLAUDE_PLUGIN_DATA='' → tokens.enc at the fs root, and
    // ZENDESK_OAUTH_CALLBACK_PORT='' → Number('')===0 → bind to port 0.
    const dataDir = env.CLAUDE_PLUGIN_DATA || defaultDataDir(env);
    return {
        config: {
            subdomain: required(env, 'ZENDESK_SUBDOMAIN'),
            clientId: required(env, 'ZENDESK_OAUTH_CLIENT_ID'),
            clientSecret: required(env, 'ZENDESK_OAUTH_CLIENT_SECRET'),
            callbackPort: Number(env.ZENDESK_OAUTH_CALLBACK_PORT || DEFAULT_CALLBACK_PORT),
            scopes: DEFAULT_SCOPES,
        },
        dataDir,
        // Single source of the token file location so server + authorize bin never drift.
        tokensPath: `${dataDir}/tokens.enc`,
    };
}
