import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildRemoteApp } from '../../src/remote/remote-server.js';
import { IssuedTokenStore } from '../../src/auth/issued-token-store.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<{ base: string; issued: IssuedTokenStore }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-cb-'));
  dirs.push(dataDir);
  const env: NodeJS.ProcessEnv = {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
    REMOTE_TOKEN_ENC_KEY: '0+k4qZ+4xicM8rKBVMRYFikJpkLODNCh33wHb08pJyU=',
    CLAUDE_PLUGIN_DATA: dataDir,
  };
  const issued = new IssuedTokenStore(join(dataDir, 'issued'), 'enc-key-123');
  const { app } = buildRemoteApp(env, { issued });
  const server = (app as unknown as { listen: (p: number) => Server }).listen(0);
  servers.push(server);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, issued };
}

const DOWNSTREAM = 'https://claude.ai/cb';

describe('upstream /callback (REQ anti-CSRF state)', () => {
  it('consumes a valid state once and redirects the code back to the downstream client', async () => {
    const { base, issued } = await boot();
    issued.pendingRedirect('state-123', DOWNSTREAM);

    const res = await fetch(`${base}/callback?code=zcode&state=state-123`, { redirect: 'manual' });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const loc = new URL(res.headers.get('location') as string);
    expect(`${loc.origin}${loc.pathname}`).toBe(DOWNSTREAM);
    expect(loc.searchParams.get('code')).toBe('zcode');
    expect(loc.searchParams.get('state')).toBe('state-123');

    // Single-use: replaying the same state is refused as possible CSRF.
    const replay = await fetch(`${base}/callback?code=zcode&state=state-123`, { redirect: 'manual' });
    expect(replay.status).toBe(403);
  });

  it('rejects an unknown state', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/callback?code=zcode&state=forged`, { redirect: 'manual' });
    expect(res.status).toBe(403);
  });

  it('rejects a callback missing code or state', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/callback?state=only-state`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  it('refuses to redirect to an off-allowlist redirect_uri (open-redirect guard, M1)', async () => {
    const { base, issued } = await boot();
    issued.pendingRedirect('evil-state', 'https://evil.example.com/steal');
    const res = await fetch(`${base}/callback?code=zcode&state=evil-state`, { redirect: 'manual' });
    expect(res.status).toBe(403);
  });
});
