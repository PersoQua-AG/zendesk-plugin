import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '../../src/server.js';
import { RateLimiter } from '../../src/client/rate-limiter.js';
import { ResponseCache } from '../../src/client/cache.js';
import type { TokenProvider } from '../../src/client/token-provider.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixtureEnv(): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-remote-'));
  dirs.push(dataDir);
  return {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
    CLAUDE_PLUGIN_DATA: dataDir,
  };
}

describe('createServer stdio path unchanged (regression)', () => {
  it('still registers exactly 64 tools with no injected deps', () => {
    const spy = vi.spyOn(McpServer.prototype, 'registerTool');
    createServer(fixtureEnv());
    expect(spy).toHaveBeenCalledTimes(64);
  });

  it('defaults reproduce the 400/10 buckets and standard security', () => {
    const { rateLimiter, incrementalRateLimiter, ctx } = createServer(fixtureEnv());
    expect(rateLimiter.requestsPerMinute).toBe(400);
    expect(incrementalRateLimiter.requestsPerMinute).toBe(10);
    expect(ctx.securityLevel).toBe('standard');
  });
});

describe('createServer dependency injection (remote path)', () => {
  it('uses the injected rate limiters and cache by identity', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zd-inj-'));
    dirs.push(dataDir);
    const rateLimiter = new RateLimiter({ requestsPerMinute: 400 });
    const incrementalRateLimiter = new RateLimiter({ requestsPerMinute: 10 });
    const cache = new ResponseCache(join(dataDir, 'custom-cache'));
    const authManager: TokenProvider = { getAccessToken: vi.fn().mockResolvedValue('tok') };

    const created = createServer(fixtureEnv(), { authManager, rateLimiter, incrementalRateLimiter, cache });

    expect(created.rateLimiter).toBe(rateLimiter);
    expect(created.incrementalRateLimiter).toBe(incrementalRateLimiter);
    expect(created.ctx.cache).toBe(cache);
  });

  it('wires the injected TokenProvider into the http client', async () => {
    const authManager: TokenProvider = { getAccessToken: vi.fn().mockResolvedValue('injected-token') };
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);

    const { ctx } = createServer(fixtureEnv(), { authManager });
    await ctx.httpClient.request('/users/me.json');

    expect(authManager.getAccessToken).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer injected-token');
  });
});
