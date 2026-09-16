import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildRemoteApp } from '../../src/remote/remote-server.js';
import { IdentityTokenStore } from '../../src/auth/identity-store.js';
import { IdentityAuthResolver } from '../../src/auth/identity-resolver.js';
import { IssuedTokenStore } from '../../src/auth/issued-token-store.js';
import { WriteAuditLog } from '../../src/remote/audit-log.js';
import type { OAuthConfig } from '../../src/auth/oauth-flow.js';

const SECRET = 'secret-xyz';

export interface RemoteHarness {
  client: Client;
  auditPath: string;
  callText(name: string, args: Record<string, unknown>): Promise<string>;
  toolNames(): Promise<string[]>;
  dispose(): Promise<void>;
}

// Boot buildRemoteApp with an injected mocked Zendesk fetch, a resolver pre-seeded with a valid
// per-user token for `identity`, and an MCP client already connected over Streamable HTTP.
export async function startRemote(
  fetchImpl: typeof fetch,
  identity = 'zendesk:1',
  seedToken = true,
  // Extra environment for the remote server, merged last. Exists so a suite can exercise a
  // configuration value the remote path reads from env (e.g. ZENDESK_SECURITY_LEVEL) without a
  // second copy of this fixture. Callers that pass nothing get exactly today's environment.
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<RemoteHarness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-remote-int-'));
  const env: NodeJS.ProcessEnv = {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: SECRET,
    CLAUDE_PLUGIN_DATA: dataDir,
    ...envOverrides,
  };
  const config: OAuthConfig = { subdomain: 'acme', clientId: 'client-abc', clientSecret: SECRET, callbackPort: 8976, scopes: ['read', 'write'] };
  const resolver = new IdentityAuthResolver(new IdentityTokenStore(join(dataDir, 'users'), SECRET), config);
  // Seed a valid, unexpired Zendesk token so the per-user AuthManager serves it without refresh.
  // seedToken=false leaves the identity unauthorized (simulates not-yet-authorized / revoked).
  if (seedToken) {
    resolver.persist(identity, { accessToken: 'zd-access', refreshToken: 'zd-refresh', expiresAt: Date.now() + 3_600_000 });
  }
  const issued = new IssuedTokenStore(join(dataDir, 'issued'), SECRET);
  const auditPath = join(dataDir, 'audit', 'write-audit.jsonl');
  const audit = new WriteAuditLog(auditPath);

  const { app } = buildRemoteApp(env, { resolver, issued, audit, fetchImpl });
  const token = issued.mint(identity);
  // Bound to 127.0.0.1, not to the wildcard, because the client below dials 127.0.0.1 and those are
  // not the same reservation. listen(0) alone binds `::` (measured on macOS/node v22:
  // address() -> {"address":"::","family":"IPv6"}), and a FOREIGN process can then bind
  // 127.0.0.1:<that same port> at the same time — the second bind succeeds, no EADDRINUSE. The
  // client's request goes to whichever process owns the IPv4 socket, which is how this harness
  // produced `Error POSTing to endpoint: Client sent an HTTP request to an HTTPS server` and
  // `SocketError: other side closed` in roughly one run in four. Binding the address the client
  // dials makes the ephemeral port a real reservation, so no other process can shadow it.
  const server = (app as unknown as { listen: (p: number, host: string) => Server }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address() as AddressInfo;
  const { port } = addr;
  // Cheap and load-bearing: if a future edit drops the host argument, the flake comes back as an
  // intermittent failure in an unrelated suite instead of failing here.
  if (addr.address !== '127.0.0.1') {
    throw new Error(`remote harness bound ${addr.address}, not 127.0.0.1 — the client dials 127.0.0.1`);
  }

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'remote-int', version: '0.0.0' });
  await client.connect(transport);

  return {
    client,
    auditPath,
    async callText(name, args) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content?: Array<{ text?: string }>;
        isError?: boolean;
      };
      const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
      if (res.isError) throw new Error(text);
      return text;
    },
    async toolNames() {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    async dispose() {
      await client.close();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// A method+path switchable Zendesk mock. Handlers key on `METHOD /path` (path without query).
export function zendeskMock(handlers: Record<string, (url: URL, init: RequestInit) => Response>): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const key = `${method} ${url.pathname}`;
    const handler = handlers[key];
    if (!handler) return new Response(JSON.stringify({ error: `unmocked ${key}` }), { status: 404 });
    return handler(url, init);
  }) as unknown as typeof fetch;
}
