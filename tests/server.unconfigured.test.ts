import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { CONFIG_ACCOUNTS } from '../src/auth/store-key.js';
import { resolveAuthConfig } from '../src/auth/config.js';
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

// What the resolver itself says is wrong with this env: the truth the answers are checked against.
function diagnosisOf(env: NodeJS.ProcessEnv, security: ReturnType<typeof keychain>): string {
  try {
    resolveAuthConfig(env, security);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('this env resolves, so nothing is missing');
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
  // Checked against what exists, not against wordings: a list of forbidden phrases is beaten by the next
  // phrasing of the same dialog (#103). The whole answer, diagnosis included, is held to two rules.
  // Every sentence must name a registered tool or a variable the configuration is read from. And every
  // clause may name, besides its opening word, only those or a surface on the short list below: a
  // capitalised word is how a text names a place (Settings, Extensions, Desktop), so any other one is a
  // surface the plugin does not have. Then the tool it names is CALLED and has to answer with the
  // setup page. It lives here rather than in security-level-claims.test.ts because this string is built
  // at RUNTIME by resolveOrDegrade, which is what this file is about.
  it('answers a Zendesk tool call by naming what is missing and how to supply it, without a stack trace', async () => {
    // A working Keychain, so what is missing really is the subdomain and not access to the Keychain.
    const env = halfConfiguredEnv();
    const security = keychain();
    const client = await connect(env, security);
    const text = textOf(await client.callTool({ name: 'zendesk_get_me', arguments: {} }));
    const diagnosis = diagnosisOf(env, security);
    expect(diagnosis).toContain('ZENDESK_SUBDOMAIN');
    expect(text).toContain(diagnosis);
    expect(text).not.toMatch(/\bat .*\.(ts|js):\d+/);

    const registered = (await client.listTools()).tools.map((t) => t.name);
    const sources = Object.keys(CONFIG_ACCOUNTS);
    // ponytail: the surfaces that exist besides tools and variables; a new one is added here on purpose.
    const known = new Set([...registered, ...sources, 'Zendesk', 'Keychain']);
    for (const sentence of text.split(/(?<=[.;])\s+|\n/)) {
      expect([...registered, ...sources].some((way) => sentence.includes(way)), `names no way in: ${sentence}`).toBe(true);
      for (const clause of sentence.split(/[:;]\s*/)) {
        const names = (clause.match(/[A-Za-z][\w'’]*/g) ?? []).slice(1).filter((w) => /^[A-Z]/.test(w));
        expect(names.filter((w) => !known.has(w)), `names a surface that does not exist: ${clause}`).toEqual([]);
      }
    }
    // On a platform without a Keychain the environment is the only way in (#69).
    for (const name of sources) expect(text).toContain(name);
    const named = [...new Set(text.match(/\bzendesk_\w+/g) ?? [])];
    expect(registered).toEqual(expect.arrayContaining(named));
    const answers = await Promise.all(named.map(async (name) => textOf(await client.callTool({ name, arguments: {} }))));
    expect(answers.join('\n'), `no tool the remedy names offers the setup page: ${named}`).toMatch(/\/setup\?t=/);
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
    expect(text).toContain('ZENDESK_OAUTH_CALLBACK_PORT must');
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
  // Every value the env carries is a canary, and either half of the required pair may be the one missing,
  // so every value is present in some run; the port is exempt because the URL must carry it.
  it.each(['ZENDESK_SUBDOMAIN', 'ZENDESK_OAUTH_CLIENT_ID'])(
    'answers zendesk_login with the first-run setup URL, and nothing else, when the Keychain works (%s missing)',
    async (missing) => {
      const env: NodeJS.ProcessEnv = {
        ...halfConfiguredEnv(),
        ZENDESK_SUBDOMAIN: 'canary-subdomain',
        ZENDESK_OAUTH_CLIENT_ID: 'canary-client-id',
        ZENDESK_OAUTH_CLIENT_SECRET: 'canary-client-secret',
      };
      delete env[missing];
      const security = keychain();
      const client = await connect(env, security);
      const text = textOf(await client.callTool({ name: 'zendesk_login', arguments: {} }));
      const link = text.split(/\s+/).find((word) => word.startsWith('http://'));
      expect(link, 'the answer carries no URL').toBeTypeOf('string');
      const url = new URL(link as string);
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
      for (const [name, value] of Object.entries(env)) {
        if (name !== 'ZENDESK_OAUTH_CALLBACK_PORT') expect(text, name).not.toContain(value);
      }
      // Nor the diagnosis: the page is the answer, and what is missing is what the page collects.
      expect(text).not.toContain(diagnosisOf(env, security));
      expect(text).not.toMatch(/\bat .*\.(ts|js):\d+/);
      expect(text).not.toMatch(/\/(Users|home|var|tmp)\//);
      await client.close();
    },
  );
});
