import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AuthManager } from './auth/auth-manager.js';
import { TokenStore } from './auth/token-store.js';
import { RateLimiter } from './client/rate-limiter.js';
import { ZendeskHttpClient } from './client/http-client.js';
import { ResponseCache } from './client/cache.js';
import { runQuery } from './client/query.js';
import { getMe } from './tools/me.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const subdomain = requireEnv('ZENDESK_SUBDOMAIN');
const clientId = requireEnv('ZENDESK_OAUTH_CLIENT_ID');
const clientSecret = requireEnv('ZENDESK_OAUTH_CLIENT_SECRET');
const dataDir = process.env.CLAUDE_PLUGIN_DATA ?? '.zendesk-plugin-data';

const tokenStore = new TokenStore(`${dataDir}/tokens.enc`, clientSecret);
const authManager = new AuthManager(tokenStore, {
  subdomain,
  clientId,
  clientSecret,
  callbackPort: Number(process.env.ZENDESK_OAUTH_CALLBACK_PORT ?? '8976'),
  scopes: ['read', 'write'],
});
const rateLimiter = new RateLimiter({ requestsPerMinute: 400 });
const httpClient = new ZendeskHttpClient({ subdomain, authManager, rateLimiter });
const cache = new ResponseCache(`${dataDir}/cache`);

const server = new McpServer({ name: 'zendesk', version: '0.1.0' });

server.registerTool(
  'zendesk_get_me',
  { description: 'Return the authenticated Zendesk user and role — use to verify auth is working.' },
  async () => {
    const result = await getMe(httpClient, cache);
    return { content: [{ type: 'text', text: `${result.summary}\n(cache: ${result.cacheHandle})` }] };
  },
);

server.registerTool(
  'zendesk_query',
  {
    description: 'Re-extract fields from a previously cached tool response without re-fetching from Zendesk.',
    inputSchema: { cacheHandle: z.string().regex(/^[A-Za-z0-9_-]+$/), query: z.string() },
  },
  async ({ cacheHandle, query }) => {
    const data = cache.load(cacheHandle);
    const result = runQuery(data, query);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
