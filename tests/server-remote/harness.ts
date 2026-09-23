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

// The ONE way a test server in this repo is put on a port. It stood as a comment inside startRemote
// and four other suites booted their own server without it (#13): callback.test.ts, rate-limit.test.ts,
// isolation.test.ts and remote-init.test.ts each called `.listen(0)` and then dialled 127.0.0.1.
//
// Those are not the same reservation. listen(0) alone binds `::` (measured on macOS/node v22:
// address() -> {"address":"::","family":"IPv6"}), and a FOREIGN process can then bind
// 127.0.0.1:<that same port> at the same time — the second bind succeeds, no EADDRINUSE. The
// client's request then goes to whichever process owns the IPv4 socket, which is how this harness
// produced `Error POSTing to endpoint: Client sent an HTTP request to an HTTPS server` and
// `SocketError: other side closed` in roughly one run in four, and callback.test.ts its
// `rejects an unknown state`. Binding the address the client dials makes the ephemeral port a real
// reservation: the socket is held from the bind until dispose, with no moment in between at which
// the port is free.
//
// The address check is cheap and load-bearing: if a future edit drops the host argument, it fails
// HERE, by name, instead of coming back as an intermittent failure in an unrelated suite.
export function listenLoopback(app: unknown): Promise<{ server: Server; port: number; base: string }> {
  return new Promise((bound, failed) => {
    const server = (app as { listen: (p: number, host: string) => Server }).listen(0, '127.0.0.1');
    // Without this the promise never settles when the bind fails, and a hung await is indis-
    // tinguishable from a slow test until the suite timeout — the liveness defect #9 was about,
    // one directory over.
    server.on('error', failed);
    server.once('listening', () => {
      const addr = server.address() as AddressInfo;
      if (addr.address !== '127.0.0.1') {
        // Closed before the throw: the caller never receives this server, so nobody else can.
        server.close();
        failed(
          new Error(
            `test server bound ${addr.address}, not 127.0.0.1 — the client dials 127.0.0.1, and a wildcard bind does not reserve it`,
          ),
        );
        return;
      }
      bound({ server, port: addr.port, base: `http://127.0.0.1:${addr.port}` });
    });
  });
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
    // Required by the default store construction (the refresh-token store is built from env);
    // 32 base64 bytes so the fail-closed strength check passes.
    REMOTE_TOKEN_ENC_KEY: '0+k4qZ+4xicM8rKBVMRYFikJpkLODNCh33wHb08pJyU=',
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
  const { server, port } = await listenLoopback(app);

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
