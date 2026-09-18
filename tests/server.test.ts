import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '../src/server.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fixtureEnv(): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-wiring-'));
  dirs.push(dataDir);
  return {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
    CLAUDE_PLUGIN_DATA: dataDir,
  };
}

describe('createServer wiring', () => {
  it('wires the 400/10 rate buckets, standard security default, and reportConfig', () => {
    const { rateLimiter, incrementalRateLimiter, ctx } = createServer(fixtureEnv());
    expect(rateLimiter.requestsPerMinute).toBe(400);
    expect(incrementalRateLimiter.requestsPerMinute).toBe(10);
    expect(ctx.securityLevel).toBe('standard');
    expect(ctx.reportConfig).toBeDefined();
  });

  // 64 Zendesk tools + zendesk_login (the Desktop Extension's in-app OAuth entry point).
  it('registers all 65 tools', () => {
    const spy = vi.spyOn(McpServer.prototype, 'registerTool');
    createServer(fixtureEnv());
    expect(spy).toHaveBeenCalledTimes(65);
  });
});
