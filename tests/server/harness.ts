import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type ServerDeps } from '../../src/server.js';
import { RateLimiter } from '../../src/client/rate-limiter.js';
import { ResponseCache } from '../../src/client/cache.js';

const dirs: string[] = [];

export function cleanupDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export function fixtureEnv(dataDir = tempDir('zd-prompts-')): NodeJS.ProcessEnv {
  return {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
    CLAUDE_PLUGIN_DATA: dataDir,
  };
}

export function unconfiguredEnv(): NodeJS.ProcessEnv {
  return { CLAUDE_PLUGIN_DATA: tempDir('zd-prompts-unconfigured-') };
}

// A data directory that is a FILE makes the cache mkdir throw ENOTDIR (the #11 degrade path).
export function degradedCacheEnv(): NodeJS.ProcessEnv {
  const file = join(tempDir('zd-prompts-degraded-'), 'not-a-directory');
  writeFileSync(file, '');
  return fixtureEnv(file);
}

// The per-session construction the remote bridge uses (src/remote/remote-server.ts).
export function remoteDeps(): ServerDeps {
  return {
    authManager: { getAccessToken: vi.fn().mockResolvedValue('tok') },
    rateLimiter: new RateLimiter({ requestsPerMinute: 400 }),
    incrementalRateLimiter: new RateLimiter({ requestsPerMinute: 10 }),
    cache: new ResponseCache(join(tempDir('zd-prompts-remote-'), 'cache')),
  };
}

export async function connect(env: NodeJS.ProcessEnv, deps?: ServerDeps): Promise<Client> {
  const { server } = createServer(env, deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'prompts', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

export function textOf(result: { messages: { content: { type: string; text?: string } }[] }): string {
  return result.messages.map((m) => m.content.text ?? '').join('\n');
}
