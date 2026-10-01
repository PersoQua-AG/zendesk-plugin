import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { abortLoginFlow } from '../../src/tools/login.js';
import { configuredKeychain, deniedKeychain } from './keychain.js';
import { freePort } from './login-harness.js';

// #68 B1, through createServer, because that is the point of this file. The first attempt at this defect
// was proved on a hand-built LoginDeps shape that src/server.ts never produced — a configured install
// takes the `auth.ok` branch, which carried no `setup` — so the fix was demonstrated on a fixture the
// product could not construct while the product still answered "there is nowhere to store a
// configuration" about the very Keychain the wrong subdomain had come out of.
//
// The lockout: `acmee` passes every rule there is, so it stores, resolves, and the plugin never degrades.
// Nothing about it is exotic — it is one keystroke — and before this there was no way back at all.

const dirs: string[] = [];
afterEach(() => {
  abortLoginFlow();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A machine that HAS been set up, with one letter wrong. Nothing is passed in the environment: the values
// come out of the Keychain, which is what a real first run leaves behind.
function configuredEnv(): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-reentry-'));
  dirs.push(dataDir);
  return { ZENDESK_OAUTH_CALLBACK_PORT: String(freePort()), CLAUDE_PLUGIN_DATA: dataDir };
}

async function connect(env: NodeJS.ProcessEnv, security: ReturnType<typeof configuredKeychain>) {
  const { server } = createServer(env, { security });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'reentry', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

const textOf = (result: unknown): string =>
  ((result as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n');

const urlIn = (text: string, scheme: string): URL =>
  new URL(text.split(/\s+/).find((word) => word.startsWith(scheme)) as string);

describe('an install that is configured, and wrong', () => {
  it('reaches the setup page again with setup=true', async () => {
    const env = configuredEnv();
    const client = await connect(env, configuredKeychain({ ZENDESK_SUBDOMAIN: 'acmee' }));
    try {
      // It really is configured: an ordinary login authorizes against the typo, which is the symptom the
      // person comes in with and the reason `force` cannot carry this.
      const ordinary = await call(client, { force: true });
      expect(urlIn(ordinary, 'https://').origin).toBe('https://acmee.zendesk.com');

      // setup=true abandons that flow and opens the page on the same lock; the listener it leaves bound
      // is the one fetched below, so nothing is aborted in between.
      const reentry = await call(client, { setup: true });
      const page = urlIn(reentry, 'http://');

      expect(page.pathname).toBe('/setup');
      expect(reentry).not.toMatch(/nowhere to store/i);
      // And the page is actually there, on the port this install was configured with.
      expect(page.port).toBe(env.ZENDESK_OAUTH_CALLBACK_PORT);
      const served = await fetch(page, { redirect: 'manual' });
      expect(served.status).toBe(200);
      expect(await served.text()).toContain('Zendesk-Plugin einrichten');
    } finally {
      await client.close();
    }
  });

  // And the answer must not claim the Keychain is unusable when it is — which is the only honest reason
  // to refuse. A denied Keychain is that reason, and then nothing resolves in the first place.
  it('says the Keychain could not be used only when that is true', async () => {
    const client = await connect(configuredEnv(), deniedKeychain());
    try {
      const answer = await call(client, { setup: true });
      expect(answer).toMatch(/could not be read/);
      expect(answer).not.toContain('/setup');
    } finally {
      await client.close();
    }
  });
});

async function call(client: Client, args: Record<string, boolean>): Promise<string> {
  return textOf(await client.callTool({ name: 'zendesk_login', arguments: args }));
}
