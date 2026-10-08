import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { CONFIG_ACCOUNTS } from '../src/auth/store-key.js';
import { deniedKeychain, fakeKeychain, keychain, TEST_STORE_KEY, TOKEN_STORE_ACCOUNT } from './auth/keychain.js';
import { freePort } from './auth/login-harness.js';
import { abortLoginFlow } from '../src/tools/login.js';

// macOS ACLs are PER ITEM, so "can anything be stored" has two halves and a keychain can answer them
// differently. This is the half QA found unguarded: the three OAuth values are denied while the
// token-store key reads fine. A setup page offered here would collect three values, fail to write them,
// and `-U` would have replaced whatever was already there on the way (#68 B3).
const configDenied = (): ReturnType<typeof keychain> =>
  fakeKeychain({
    items: { [TOKEN_STORE_ACCOUNT]: TEST_STORE_KEY },
    failRead: Object.fromEntries(Object.values(CONFIG_ACCOUNTS).map((account) => [account, 51])),
  }).run;

const dirs: string[] = [];
afterEach(() => {
  // A setup flow holds a BOUND listener for its whole window; a case that leaves one behind makes the
  // next one depend on the order it ran in, and holds the port for fifteen minutes.
  abortLoginFlow();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A host starts the server BEFORE anything is configured — Claude Code launches it on install, and
// the environment may carry only part of what is needed. Crashing there shows a dead server with no
// explanation, so it starts anyway and every tool answers with the field still to supply.
function halfConfiguredEnv(): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-unconfigured-'));
  dirs.push(dataDir);
  // A port out of the suite's own band, never the shipped default: this env reaches a REAL listener
  // as soon as the setup page is offered (tests/auth/login-harness.ts explains the band).
  return {
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CALLBACK_PORT: String(freePort()),
    ZENDESK_DATA_DIR: dataDir,
  };
}

async function connect(env: NodeJS.ProcessEnv, security = deniedKeychain()) {
  const { server } = createServer(env, { security });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'unconfigured', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

function textOf(result: unknown): string {
  return ((result as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n');
}

describe('createServer with incomplete extension configuration', () => {
  it('still registers the full tool surface so the host lists the extension normally', async () => {
    const client = await connect(halfConfiguredEnv());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('zendesk_login');
    await client.close();
  });

  // GATE-GAP 13: the remedy names the tool that can fix it. "Settings → Extensions → Zendesk" used to
  // come FIRST, and on the Claude Code plugin that dialog does not exist any more — #68 removed its
  // user_config, because the host bridge dropped the whole server over it.
  //
  // Both halves, in the form tests/plugin/security-level-claims.test.ts uses for shipped documents:
  // the correction is THERE and the withdrawn promise is GONE. A remedy-only check would wave through
  // an answer that still sent the operator to the retired extension's dialog, and this is the only
  // gate on that text. It lives here rather than beside the shipped-text claims in
  // security-level-claims.test.ts because the subject differs: that file reads STATIC files from disk
  // and is scoped to #59's screening-level promise, while this string is built at RUNTIME by
  // resolveOrDegrade, which is what this file is about.
  it('answers a Zendesk tool call by naming what is missing and how to supply it, without a stack trace', async () => {
    // A working Keychain, so what is missing really is the subdomain and not access to the Keychain.
    const client = await connect(halfConfiguredEnv(), keychain());
    const text = textOf(await client.callTool({ name: 'zendesk_get_me', arguments: {} }));
    expect(text).toContain('ZENDESK_SUBDOMAIN');
    expect(text).toMatch(/zendesk_login/);
    expect(text).toMatch(/setup page/i);
    expect(text).not.toMatch(/\bat .*\.(ts|js):\d+/);
    // The retired MCPB path (#103) must not come back as a remedy: there is no Desktop Extension and
    // no settings dialog on any shipped path, so an operator sent there cannot arrive.
    expect(text).not.toMatch(/desktop extension/i);
    expect(text).not.toMatch(/configuration dialog/i);
    expect(text).not.toMatch(/Settings → Extensions/);
    await client.close();
  });

  // With nowhere to store what a setup page would collect — a locked Keychain, a denied prompt, or a
  // platform that has none (#69) — the message that names what is missing is still the whole answer.
  it('answers zendesk_login with that same message when nothing can be stored', async () => {
    const client = await connect(halfConfiguredEnv());
    const text = textOf(await client.callTool({ name: 'zendesk_login', arguments: {} }));
    expect(text).toContain('ZENDESK_SUBDOMAIN');
    expect(text).not.toContain('/setup');
    await client.close();
  });

  // N2's edge: the port is validated AFTER the subdomain, so a start with BOTH problems reported only the
  // subdomain — and the person then registered the redirect URL for 8976 on the page's word, finished
  // setup, and the next start threw on the port. Driven with a Keychain that cannot store, so no page is
  // offered and nothing binds the shipped default: what is asserted is the ANSWER naming both problems.
  it('names an unusable callback port as well as the missing value', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zd-badport-'));
    dirs.push(dataDir);
    const client = await connect({ ZENDESK_OAUTH_CALLBACK_PORT: '70000', ZENDESK_DATA_DIR: dataDir });
    const text = textOf(await client.callTool({ name: 'zendesk_get_me', arguments: {} }));

    expect(text).toContain('ZENDESK_SUBDOMAIN');
    expect(text).toContain('ZENDESK_OAUTH_CALLBACK_PORT="70000"');
    expect(text).toContain('oauth_callback_port');
    expect(text).toContain('8976');
    await client.close();
  });

  // The per-item half of the same question (#68 B3). The key reads, so the OLD gate said "offer setup";
  // the three values do not, so nothing it collected could be stored.
  it('offers no setup page when the three values are denied but the key is readable', async () => {
    const client = await connect(halfConfiguredEnv(), configDenied());
    const text = textOf(await client.callTool({ name: 'zendesk_login', arguments: {} }));
    expect(text).toMatch(/could not be read/);
    expect(text).not.toContain('/setup');
    await client.close();
  });

  // And where it CAN be stored, the answer is the setup page and nothing else. Not the subdomain, not
  // the data directory, not a stack: the page is local, and what the user types there stays local.
  it('answers zendesk_login with the first-run setup URL, and nothing else, when the Keychain works', async () => {
    const env = halfConfiguredEnv();
    const client = await connect(env, keychain());
    const text = textOf(await client.callTool({ name: 'zendesk_login', arguments: {} }));
    const url = new URL(text.split(/\s+/).find((word) => word.startsWith('http://')) as string);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/setup');
    // The PORT this install was configured with, not the shipped default. resolveAuthConfig validates the
    // subdomain before the port and throws there, so a degraded start used to serve on 8976 — and the one
    // person who sets a different port does so because 8976 is taken, which is both the port the page
    // would have told them to register and the one it could not bind.
    expect(url.port).toBe(env.ZENDESK_OAUTH_CALLBACK_PORT);
    const page = await fetch(url, { redirect: 'manual' });
    expect(await page.text()).toContain(`http://localhost:${env.ZENDESK_OAUTH_CALLBACK_PORT}/callback`);
    expect(url.searchParams.get('t')).toMatch(/^[\w-]{43}$/);
    expect(text).not.toContain('zendesk_subdomain');
    expect(text).not.toContain('client-abc');
    expect(text).not.toMatch(/\bat .*\.(ts|js):\d+/);
    expect(text).not.toMatch(/\/(Users|home|var|tmp)\//);
    await client.close();
  });
});
