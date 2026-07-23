import type { OAuthConfig } from './oauth-flow.js';

const DEFAULT_CALLBACK_PORT = 8976;
const DEFAULT_DATA_DIR = '.zendesk-plugin-data';
const DEFAULT_SCOPES = ['read', 'write'];

export interface ResolvedAuthConfig {
  config: OAuthConfig;
  dataDir: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Single source of env resolution shared by server + authorize bin, so identical
// env yields an identical clientSecret + dataDir → identical TokenStore key/path.
export function resolveAuthConfig(env: NodeJS.ProcessEnv): ResolvedAuthConfig {
  return {
    config: {
      subdomain: required(env, 'ZENDESK_SUBDOMAIN'),
      clientId: required(env, 'ZENDESK_OAUTH_CLIENT_ID'),
      clientSecret: required(env, 'ZENDESK_OAUTH_CLIENT_SECRET'),
      callbackPort: Number(env.ZENDESK_OAUTH_CALLBACK_PORT ?? String(DEFAULT_CALLBACK_PORT)),
      scopes: DEFAULT_SCOPES,
    },
    dataDir: env.CLAUDE_PLUGIN_DATA ?? DEFAULT_DATA_DIR,
  };
}
