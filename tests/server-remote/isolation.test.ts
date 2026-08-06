import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { sessionCacheDir, createAuditObserver } from '../../src/remote/session-manager.js';
import { ResponseCache } from '../../src/client/cache.js';
import { WriteAuditLog } from '../../src/remote/audit-log.js';
import { buildRemoteApp } from '../../src/remote/remote-server.js';
import { IdentityTokenStore } from '../../src/auth/identity-store.js';
import { IdentityAuthResolver } from '../../src/auth/identity-resolver.js';
import { IssuedTokenStore } from '../../src/auth/issued-token-store.js';
import type { OAuthConfig } from '../../src/auth/oauth-flow.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'zd-iso-'));
  dirs.push(d);
  return d;
}

describe('per-user session isolation', () => {
  it('derives a distinct cache dir per identity, same dir for same identity', () => {
    const dataDir = tmp();
    const u1 = sessionCacheDir(dataDir, 'zendesk:1');
    const u2 = sessionCacheDir(dataDir, 'zendesk:2');
    expect(u1).not.toBe(u2);
    expect(sessionCacheDir(dataDir, 'zendesk:1')).toBe(u1);
    expect(u1.startsWith(join(dataDir, 'cache'))).toBe(true);
  });

  it('U2 cannot load a cache handle minted in U1 cache dir', () => {
    const dataDir = tmp();
    const c1 = new ResponseCache(sessionCacheDir(dataDir, 'zendesk:1'));
    const c2 = new ResponseCache(sessionCacheDir(dataDir, 'zendesk:2'));
    const { handle } = c1.save('zendesk_search', { secret: 'U1-only' });
    expect(c1.load(handle)).toEqual({ secret: 'U1-only' });
    expect(() => c2.load(handle)).toThrow(/not found/i);
  });
});

describe('write-audit observer', () => {
  const callMsg = (name: string, args: Record<string, unknown>): JSONRPCMessage => ({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const okResult = (text: string): JSONRPCMessage => ({
    jsonrpc: '2.0',
    id: 7,
    result: { content: [{ type: 'text', text }] },
  });

  it('records one entry per write with the hashed identity and derived target', () => {
    const path = join(tmp(), 'audit.jsonl');
    const audit = new WriteAuditLog(path);
    const obs = createAuditObserver(audit, 'zendesk:1');

    obs.onInbound(callMsg('zendesk_update_ticket', { id: 42 }));
    obs.onOutbound(okResult('Updated ticket #42'));

    const entries = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tool: 'zendesk_update_ticket', targetId: '42', outcome: 'applied' });
    expect(readFileSync(path, 'utf8')).not.toContain('zendesk:1'); // identity hashed, not raw
  });

  it('classifies a conflict result and ignores read tools', () => {
    const path = join(tmp(), 'audit.jsonl');
    const audit = new WriteAuditLog(path);
    const obs = createAuditObserver(audit, 'zendesk:9');

    obs.onInbound(callMsg('zendesk_search', { query: 'x' })); // read → not audited
    obs.onOutbound(okResult('results'));
    obs.onInbound(callMsg('zendesk_update_ticket', { ticket_id: 5 }));
    obs.onOutbound(okResult('Conflict: ticket changed since read'));

    const entries = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tool: 'zendesk_update_ticket', targetId: '5', outcome: 'conflict' });
  });
});

const SECRET = 'secret-xyz';

// Boots the real remote app with two seeded identities and a Zendesk mock that records the bearer
// on every upstream call, so a test can prove which identity's token actually reached Zendesk.
async function bootTwoIdentity(zdTokens: Record<string, string>): Promise<{
  base: string;
  issued: IssuedTokenStore;
  zdBearers: string[];
}> {
  const dataDir = tmp();
  const env: NodeJS.ProcessEnv = {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: SECRET,
    REMOTE_TOKEN_ENC_KEY: 'enc-key-123',
    CLAUDE_PLUGIN_DATA: dataDir,
  };
  const config: OAuthConfig = { subdomain: 'acme', clientId: 'client-abc', clientSecret: SECRET, callbackPort: 8976, scopes: ['read', 'write'] };
  const resolver = new IdentityAuthResolver(new IdentityTokenStore(join(dataDir, 'users'), 'enc-key-123'), config);
  for (const [identity, zdToken] of Object.entries(zdTokens)) {
    resolver.persist(identity, { accessToken: zdToken, refreshToken: 'zd-refresh', expiresAt: Date.now() + 3_600_000 });
  }
  const issued = new IssuedTokenStore(join(dataDir, 'issued'), 'enc-key-123');
  const zdBearers: string[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
    if (auth) zdBearers.push(auth);
    return new Response(JSON.stringify({ results: [], count: 0, next_page: null }), { status: 200 });
  }) as unknown as typeof fetch;

  const { app } = buildRemoteApp(env, { resolver, issued, fetchImpl });
  const server = (app as unknown as { listen: (p: number) => Server }).listen(0);
  servers.push(server);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, issued, zdBearers };
}

describe('cross-identity session hijack (REQ security)', () => {
  it('rejects B driving A session id and never uses A token for B request', async () => {
    const { base, issued, zdBearers } = await bootTwoIdentity({
      'zendesk:A': 'ZD-TOKEN-A',
      'zendesk:B': 'ZD-TOKEN-B',
    });
    const tokenA = issued.mint('zendesk:A');
    const tokenB = issued.mint('zendesk:B');

    // A opens a real session over the live transport and drives a read — proves the legit path
    // works and that A's own Zendesk token is the one that reaches Zendesk.
    const transportA = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokenA}` } },
    });
    const clientA = new Client({ name: 'iso-A', version: '0.0.0' });
    await clientA.connect(transportA);
    const sidA = transportA.sessionId;
    expect(sidA).toBeTruthy();
    await clientA.callTool({ name: 'zendesk_search', arguments: { query: 'x', type: 'ticket' } });
    expect(zdBearers).toContain('Bearer ZD-TOKEN-A');
    const callsBeforeAttack = zdBearers.length;

    // B has a valid bearer but presents A's session id — the proven hijack vector.
    const attack = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${tokenB}`,
        'mcp-session-id': sidA as string,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'zendesk_search', arguments: { query: 'y', type: 'ticket' } } }),
    });

    expect(attack.status).toBe(403);
    // The hijack request triggered NO upstream Zendesk call at all: A's token was not driven by B,
    // and B's token never touched A's session.
    expect(zdBearers.length).toBe(callsBeforeAttack);
    expect(zdBearers).not.toContain('Bearer ZD-TOKEN-B');

    await clientA.close();
  });
});
