import type { OAuthConfig } from './oauth-flow.js';

const DEFAULT_CALLBACK_PORT = 8976;
const DEFAULT_DATA_DIR = '.zendesk-plugin-data';
const DEFAULT_SCOPES = ['read', 'write'];

export interface ResolvedAuthConfig {
  config: OAuthConfig;
  dataDir: string;
  tokensPath: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Single source of env resolution shared by server + authorize bin, so identical
// env yields an identical clientSecret + dataDir → identical TokenStore key/path.
export function resolveAuthConfig(env: NodeJS.ProcessEnv): ResolvedAuthConfig {
  // Falsy-coalesce (not ??): an empty-string env var is "absent", not a value.
  // Otherwise CLAUDE_PLUGIN_DATA='' → tokens.enc at the fs root, and
  // ZENDESK_OAUTH_CALLBACK_PORT='' → Number('')===0 → bind to port 0.
  const dataDir = env.CLAUDE_PLUGIN_DATA || DEFAULT_DATA_DIR;
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
