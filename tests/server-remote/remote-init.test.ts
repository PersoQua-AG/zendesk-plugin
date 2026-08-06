import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildRemoteApp } from '../../src/remote/remote-server.js';
import { IssuedTokenStore } from '../../src/auth/issued-token-store.js';
import { WriteAuditLog, RETENTION_MS } from '../../src/remote/audit-log.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixtureEnv(): { env: NodeJS.ProcessEnv; issued: IssuedTokenStore } {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-init-'));
  dirs.push(dataDir);
  const env: NodeJS.ProcessEnv = {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
    REMOTE_TOKEN_ENC_KEY: '0+k4qZ+4xicM8rKBVMRYFikJpkLODNCh33wHb08pJyU=',
    CLAUDE_PLUGIN_DATA: dataDir,
  };
  const issued = new IssuedTokenStore(join(dataDir, 'issued'), 'secret-xyz');
  return { env, issued };
}

async function start(): Promise<{ base: string; token: string }> {
  const { env, issued } = fixtureEnv();
  const { app } = buildRemoteApp(env, { issued });
  const token = issued.mint('zendesk:test');
  const server = (app as unknown as { listen: (p: number) => Server }).listen(0);
  servers.push(server);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, token };
}

function connect(base: string, token: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  return { client: new Client({ name: 'remote-init', version: '0.0.0' }), transport };
}

describe('remote entrypoint', () => {
  it('serves /health', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('initializes an authenticated MCP session and lists the 64 tools', async () => {
    const { base, token } = await start();
    const { client, transport } = connect(base, token);
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(64);
    await client.close();
  });

  it('rejects an MCP call with no bearer as unauthorized (no Zendesk call)', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('enforces audit retention at startup (expired line pruned)', () => {
    const { env } = fixtureEnv();
    const auditPath = join(env.CLAUDE_PLUGIN_DATA as string, 'audit', 'write-audit.jsonl');
    mkdirSync(join(env.CLAUDE_PLUGIN_DATA as string, 'audit'), { recursive: true });
    const expired = JSON.stringify({ ts: Date.now() - RETENTION_MS - 1, identityHash: 'h', tool: 't', targetId: '1', outcome: 'applied' });
    writeFileSync(auditPath, `${expired}\n`);

    buildRemoteApp(env, { audit: new WriteAuditLog(auditPath) });
    expect(readFileSync(auditPath, 'utf8').trim()).toBe(''); // pruned by the startup sweep
  });

  it('refuses to boot with a weak REMOTE_TOKEN_ENC_KEY and boots with a strong one (M3)', () => {
    const { env } = fixtureEnv();
    expect(() => buildRemoteApp({ ...env, REMOTE_TOKEN_ENC_KEY: 'too-short' })).toThrow(/too weak/i);
    expect(() => buildRemoteApp(env)).not.toThrow(); // fixtureEnv key is 32 base64 bytes
  });

  it('rejects a non-initialize frame without a session id with 4xx and survives', async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // Process/other sessions survive: a fresh valid session still initializes.
    const { client, transport } = connect(base, token);
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(64);
    await client.close();
  });
});
