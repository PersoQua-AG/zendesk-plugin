import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { readStoreKey } from './auth/store-key-stub.js';
import { freePort } from './auth/login-harness.js';
import { abortLoginFlow } from '../src/tools/login.js';

// Nothing stored, and nothing read from the developer's own Keychain either: an incomplete env is
// exactly the case where resolveAuthConfig consults it, so every server built here says what it has.
const noStoredConfig = () => ({});

// The key source as a fresh machine has it (a usable Keychain) and as a locked one — or a platform
// without one (#69) — has it. It is what decides whether a first-run setup can be offered at all.
const keychainDenied = (): string => {
  throw new Error('The macOS Keychain could not be read (security exited 51).');
};

const dirs: string[] = [];
afterEach(() => {
  // A setup flow holds a BOUND listener for its whole window; a case that leaves one behind makes the
  // next one depend on the order it ran in, and holds the port for fifteen minutes.
  abortLoginFlow();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A Desktop Extension host starts the server BEFORE the user has filled in the configuration
// dialog. Crashing there shows the user a dead extension with no explanation, so the server starts
// and every tool answers with the field to fill in instead.
function halfConfiguredEnv(): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-unconfigured-'));
  dirs.push(dataDir);
  // A port out of the suite's own band, never the shipped default: this env reaches a REAL listener
  // as soon as the setup page is offered (tests/auth/login-harness.ts explains the band).
  return {
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CALLBACK_PORT: String(freePort()),
    CLAUDE_PLUGIN_DATA: dataDir,
  };
}

async function connect(env: NodeJS.ProcessEnv, storeKey: () => string = keychainDenied) {
  const { server } = createServer(env, { readStoreKey: storeKey, readConfig: noStoredConfig });
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

  it('answers a Zendesk tool call by naming the empty user_config field, without a stack trace', async () => {
    const client = await connect(halfConfiguredEnv());
    const result = await client.callTool({ name: 'zendesk_get_me', arguments: {} });
    const text = textOf(result);
    expect(text).toContain('zendesk_subdomain');
    expect(text).toMatch(/Settings/i);
    expect(text).not.toMatch(/\bat .*\.(ts|js):\d+/);
    await client.close();
  });

  // With nowhere to store what a setup page would collect — a locked Keychain, a denied prompt, or a
  // platform that has none (#69) — the field-naming message is still the whole answer.
  it('answers zendesk_login with the same actionable message when nothing can be stored', async () => {
    const client = await connect(halfConfiguredEnv());
    const text = textOf(await client.callTool({ name: 'zendesk_login', arguments: {} }));
    expect(text).toContain('zendesk_subdomain');
    expect(text).not.toContain('/setup');
    await client.close();
  });

  // And where it CAN be stored, the answer is the setup page and nothing else. Not the subdomain, not
  // the data directory, not a stack: the page is local, and what the user types there stays local.
  it('answers zendesk_login with the first-run setup URL, and nothing else, when the Keychain works', async () => {
    const client = await connect(halfConfiguredEnv(), readStoreKey);
    const text = textOf(await client.callTool({ name: 'zendesk_login', arguments: {} }));
    const url = new URL(text.split(/\s+/).find((word) => word.startsWith('http://')) as string);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/setup');
    expect(url.searchParams.get('t')).toMatch(/^[\w-]{43}$/);
    expect(text).not.toContain('zendesk_subdomain');
    expect(text).not.toContain('client-abc');
    expect(text).not.toMatch(/\bat .*\.(ts|js):\d+/);
    expect(text).not.toMatch(/\/(Users|home|var|tmp)\//);
    await client.close();
  });
});
