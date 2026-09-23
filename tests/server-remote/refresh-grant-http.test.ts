import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildRemoteApp } from '../../src/remote/remote-server.js';
import { IssuedTokenStore, REFRESH_TTL_MS } from '../../src/auth/issued-token-store.js';
import { IdentityTokenStore } from '../../src/auth/identity-store.js';
import { IdentityAuthResolver } from '../../src/auth/identity-resolver.js';
import { CONNECTOR } from '../../src/remote/connector-contract.js';
import type { OAuthConfig } from '../../src/auth/oauth-flow.js';

// End-to-end over the REAL /token endpoint: the provider's error type only matters through the
// status and body the MCP SDK's token handler actually produces.

const KEY = '0+k4qZ+4xicM8rKBVMRYFikJpkLODNCh33wHb08pJyU=';
const SECRET = 'secret-xyz';
const IDENTITY = 'zendesk:4711';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Started {
  base: string;
  clientId: string;
  refreshToken: string;
  issued: IssuedTokenStore;
  resolver: IdentityAuthResolver;
}

async function start({ liveSession = true }: { liveSession?: boolean } = {}): Promise<Started> {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-refresh-http-'));
  dirs.push(dataDir);
  const env: NodeJS.ProcessEnv = {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: SECRET,
    REMOTE_TOKEN_ENC_KEY: KEY,
    CLAUDE_PLUGIN_DATA: dataDir,
  };
  const config: OAuthConfig = { subdomain: 'acme', clientId: 'client-abc', clientSecret: SECRET, callbackPort: 8976, scopes: ['read', 'write'] };
  const resolver = new IdentityAuthResolver(new IdentityTokenStore(join(dataDir, 'users'), KEY), config);
  if (liveSession) {
    resolver.persist(IDENTITY, { accessToken: 'zd-access', refreshToken: 'zd-refresh', expiresAt: Date.now() + 3_600_000 });
  }
  const issued = new IssuedTokenStore(join(dataDir, 'issued'), KEY);
  const refreshTokens = new IssuedTokenStore(join(dataDir, 'refresh'), KEY, REFRESH_TTL_MS);

  // A public DCR client, as claude.ai registers: client_id in the body is the whole client auth.
  const client = CONNECTOR.clientsStore().registerClient!({
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none',
  } as never) as { client_id: string };

  const { app } = buildRemoteApp(env, { resolver, issued, refreshTokens });
  const refreshToken = refreshTokens.mint(IDENTITY, client.client_id);
  const server = (app as unknown as { listen: (p: number) => Server }).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, clientId: client.client_id, refreshToken, issued, resolver };
}

async function postRefresh(base: string, clientId: string, refreshToken: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('downstream refresh grant over /token (AC1–AC5)', () => {
  it('advertises the refresh grant in the authorization-server metadata', async () => {
    const { base } = await start();
    const meta = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as {
      grant_types_supported: string[];
    };
    expect(meta.grant_types_supported).toContain('refresh_token');
  });

  it('exchanges a refresh token for a working access token WITHOUT a browser authorize', async () => {
    const { base, clientId, refreshToken } = await start();
    const { status, body } = await postRefresh(base, clientId, refreshToken);

    expect(status).toBe(200);
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.refresh_token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.refresh_token).not.toBe(refreshToken); // rotated
    expect(body.expires_in).toBe(3600);

    // The minted bearer really authenticates an MCP request (401 would mean it does not).
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${String(body.access_token)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(mcp.status).not.toBe(401);
  });

  it('refuses a REPLAYED refresh token with an OAuth invalid_grant body and never a 500', async () => {
    const { base, clientId, refreshToken } = await start();
    expect((await postRefresh(base, clientId, refreshToken)).status).toBe(200);

    const replay = await postRefresh(base, clientId, refreshToken);
    // The MCP SDK's token handler maps EVERY non-ServerError OAuthError to 400 — the status is not
    // ours to choose (node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/handlers/token.js:96).
    // What is ours, and what the acceptance criterion is really about, is that this is a clean
    // re-auth signal and not a 500: invalid_grant is exactly the code an OAuth client drops its
    // refresh token on. See the handover note on AC4.
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect(replay.status).not.toBe(500);
    expect(JSON.stringify(replay.body)).not.toContain(refreshToken);
  });

  it('refuses an unknown refresh token', async () => {
    const { base, clientId } = await start();
    const res = await postRefresh(base, clientId, 'f'.repeat(64));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('refuses when the underlying Zendesk session is gone', async () => {
    const { base, clientId, refreshToken } = await start({ liveSession: false });
    const res = await postRefresh(base, clientId, refreshToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('refuses an issued ACCESS token presented in the refresh_token slot', async () => {
    const { base, clientId, issued } = await start();
    const accessToken = issued.mint(IDENTITY, clientId);
    const res = await postRefresh(base, clientId, accessToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('goes fully inert when the pinned contract turns the grant off (AC1)', async () => {
    const pinned = CONNECTOR.refreshGrant;
    CONNECTOR.refreshGrant = false;
    try {
      // buildRemoteApp must then construct NO refresh store at all, so the provider mints no
      // refresh_token and refuses every refresh — with no edit anywhere downstream.
      const { base, clientId, refreshToken } = await start();
      const res = await postRefresh(base, clientId, refreshToken);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    } finally {
      CONNECTOR.refreshGrant = pinned;
    }
  });

  it('refuses a refresh token presented by a second registered client (cross-client substitution)', async () => {
    const { base, refreshToken } = await start();
    const other = CONNECTOR.clientsStore().registerClient!({
      redirect_uris: ['https://evil.example/cb'],
      token_endpoint_auth_method: 'none',
    } as never) as { client_id: string };
    const res = await postRefresh(base, other.client_id, refreshToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });
});
