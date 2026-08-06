import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildRemoteApp } from '../../src/remote/remote-server.js';
import { IssuedTokenStore } from '../../src/auth/issued-token-store.js';
import { CONNECTOR } from '../../src/remote/connector-contract.js';

const KEY = '0+k4qZ+4xicM8rKBVMRYFikJpkLODNCh33wHb08pJyU=';
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<string> {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-rl-'));
  dirs.push(dataDir);
  const env: NodeJS.ProcessEnv = {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
    REMOTE_TOKEN_ENC_KEY: KEY,
    CLAUDE_PLUGIN_DATA: dataDir,
  };
  const issued = new IssuedTokenStore(join(dataDir, 'issued'), KEY);
  const { app } = buildRemoteApp(env, { issued });
  const server = (app as unknown as { listen: (p: number) => Server }).listen(0);
  servers.push(server);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = (server.address() as AddressInfo);
  return `http://127.0.0.1:${port}`;
}

describe('HTTP rate limiting (H1)', () => {
  it('returns 429 once the per-IP OAuth limit is exceeded', async () => {
    const base = await boot();
    let sawLimited = false;
    for (let i = 0; i < 65; i += 1) {
      const res = await fetch(`${base}/token`, { method: 'POST' });
      if (res.status === 429) {
        sawLimited = true;
        break;
      }
    }
    expect(sawLimited).toBe(true);
  });

  it('caps the DCR clients store past its hard limit', () => {
    const store = CONNECTOR.clientsStore();
    let threw = false;
    for (let i = 0; i < 1001; i += 1) {
      try {
        store.registerClient({ redirect_uris: ['https://claude.ai/cb'] } as never);
      } catch {
        threw = true;
        break;
      }
    }
    expect(threw).toBe(true);
  });
});
