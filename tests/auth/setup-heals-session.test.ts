import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { abortLoginFlow } from '../../src/tools/login.js';
import { keychain } from './keychain.js';
import { freePort } from './login-harness.js';

// The owner's point, as a test: after the setup page has stored a configuration, THIS session uses it.
// Two things were frozen before the configuration existed — the token boundary (an AuthManager with no
// store) and the Zendesk host (a base URL built once in ZendeskHttpClient) — and healing only the first
// would have sent every request to https://.zendesk.com, which is why the client now takes a late
// subdomain. Nothing has to be reloaded and nothing has to be restarted.

const dirs: string[] = [];
afterEach(() => {
  abortLoginFlow();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function unconfiguredEnv(): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-heal-'));
  dirs.push(dataDir);
  // A port from the suite's band: the setup page binds a REAL listener on it.
  return { ZENDESK_OAUTH_CALLBACK_PORT: String(freePort()), ZENDESK_DATA_DIR: dataDir };
}

const textOf = (result: unknown): string =>
  ((result as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n');

const urlIn = (text: string, scheme: string): URL =>
  new URL(text.split(/\s+/).find((word) => word.startsWith(scheme)) as string);

describe('a session that was started before the plugin was configured', () => {
  it('uses the configuration the setup page stored, with no reload and no restart', async () => {
    const env = unconfiguredEnv();
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ user: { id: 1, name: 'Agent', email: 'agent@acme.test', role: 'admin' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const { server } = createServer(env, { security: keychain(), fetchImpl });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'heal', version: '0.0.0' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    try {
      // Before: every Zendesk request fails at the token boundary and nothing reaches the network.
      expect(textOf(await client.callTool({ name: 'zendesk_get_me', arguments: {} }))).toContain('ZENDESK_SUBDOMAIN');
      expect(requested).toEqual([]);

      // The setup page, straight from the login tool.
      const setupPage = urlIn(textOf(await client.callTool({ name: 'zendesk_login', arguments: {} })), 'http://');
      const submitted = await fetch(setupPage, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: setupPage.origin },
        body: new URLSearchParams({ subdomain: 'acme', client_id: 'client-abc', client_secret: 'secret-xyz' }).toString(),
      });
      const authorize = new URL(submitted.headers.get('location') as string);

      // The browser comes back from Zendesk on the same listener, and call 2 finishes the login. The
      // token exchange is the one call this test stubs — through the global fetch, because the server
      // builds its own login deps — and the URL it is asked for is itself proof that the configuration
      // the PAGE supplied is the one in use.
      const loopback = globalThis.fetch;
      const exchanged: string[] = [];
      vi.stubGlobal('fetch', (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith('http://')) {
          exchanged.push(url);
          return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return loopback(input, init);
      }) as typeof fetch);
      try {
        await fetch(
          `${authorize.searchParams.get('redirect_uri')}?state=${authorize.searchParams.get('state')}&code=code-1`,
        );
        const finished = textOf(await client.callTool({ name: 'zendesk_login', arguments: {} }));
        expect(finished).toMatch(/authorization complete/i);
        expect(exchanged).toEqual(['https://acme.zendesk.com/oauth/tokens']);
      } finally {
        vi.unstubAllGlobals();
      }

      // After: the SAME session answers a Zendesk tool, and the request went to the right host.
      const me = textOf(await client.callTool({ name: 'zendesk_get_me', arguments: {} }));
      expect(me).toContain('Agent');
      expect(requested.filter((url) => url.includes('/api/v2'))).toEqual([
        'https://acme.zendesk.com/api/v2/users/me.json',
      ]);
      // The defect this closes: a healed token boundary over a frozen base URL.
      for (const url of requested) expect(url).not.toContain('https://.zendesk.com');

      // And the login tool must not contradict the tool call before it. It answered "Zendesk is not set
      // up on this machine yet" immediately after a healed session had served a Zendesk request, because
      // the degraded reason outlived the reason for it — which also re-published the setup page and held
      // the callback port for another fifteen minutes.
      const afterwards = textOf(await client.callTool({ name: 'zendesk_login', arguments: {} }));
      expect(afterwards).toMatch(/already authorized/i);
      expect(afterwards).not.toMatch(/not set up/i);
      expect(afterwards).not.toContain('/setup');
    } finally {
      await client.close();
    }
  });
});
