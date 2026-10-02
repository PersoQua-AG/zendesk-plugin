import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { diagnosticsReport, substitutionState } from '../../src/tools/diagnostics.js';
import { createServer } from '../../src/server.js';
import { keychain } from '../auth/keychain.js';
import { freePort } from '../auth/login-harness.js';

// Why this tool exists at all: Claude Desktop loads no local plugin — it serves plugins from the
// account marketplace, which pulls `main` — so the only way to measure the host is to ship the
// measurement. Which makes the rule below the important one: it reports FACTS ABOUT values, never
// values, so the output is safe to paste into an issue.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zd-diagnostics-'));
  dirs.push(dir);
  return dir;
}

describe('substitution state', () => {
  it('separates substituted, left-as-a-placeholder and unset', () => {
    expect(substitutionState('/Users/x/plugin')).toBe('substituted');
    expect(substitutionState('${CLAUDE_PLUGIN_ROOT}')).toBe('literal-placeholder');
    expect(substitutionState('${user_config.anything}')).toBe('literal-placeholder');
    expect(substitutionState(undefined)).toBe('unset');
    // An empty string is a host that substituted nothing usable; "unset" is the honest reading, and
    // it is what every other resolver in src/auth/config.ts does with one.
    expect(substitutionState('')).toBe('unset');
  });
});

describe('the diagnostics report', () => {
  it('names the host and the two variables STATES, never their values', async () => {
    const text = await diagnosticsReport({
      rawEnv: { CLAUDE_PLUGIN_ROOT: '/Users/secretname/plugins/zendesk', CLAUDE_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}' },
      callbackPort: freePort(),
      clientCapabilities: { elicitation: {} },
    });

    expect(text).toContain(`hostname: ${hostname()}`);
    expect(text).toContain(`platform: ${process.platform}`);
    expect(text).toContain(`os release: ${release()}`);
    expect(text).toContain('CLAUDE_PLUGIN_ROOT: substituted');
    expect(text).toContain('CLAUDE_PLUGIN_DATA: literal-placeholder');
    expect(text).not.toContain('secretname');
    expect(text).not.toContain('${CLAUDE_PLUGIN_DATA}');
  });

  // Verbatim, because the question it answers is which elicitation modes this client announces, and a
  // summary written before the answer is known would drop exactly the field nobody expected.
  it('renders the client capabilities from initialize verbatim', async () => {
    const capabilities = { elicitation: { modes: ['form', 'url'] }, roots: { listChanged: true } };
    const text = await diagnosticsReport({ rawEnv: {}, callbackPort: freePort(), clientCapabilities: capabilities });
    expect(text).toContain(JSON.stringify(capabilities, null, 2));
  });

  it('says so plainly when the client announced no capabilities at all', async () => {
    const text = await diagnosticsReport({ rawEnv: {}, callbackPort: freePort(), clientCapabilities: undefined });
    expect(text).toContain('null');
  });

  it('probes the real port by binding it, and reports the code when it cannot', async () => {
    const port = freePort();
    const free = await diagnosticsReport({ rawEnv: {}, callbackPort: port, clientCapabilities: {} });
    expect(free).toContain(`127.0.0.1:${port} binds`);

    // A port below 1024 is privileged, which is the one unavailability every runner agrees on.
    const refused = await diagnosticsReport({ rawEnv: {}, callbackPort: 1, clientCapabilities: {} });
    expect(refused).toMatch(/127\.0\.0\.1:1 unavailable \(E[A-Z]+\)/);
  });
});

describe('zendesk_diagnostics as a tool', () => {
  it('answers over the MCP boundary, with the capabilities the client actually announced', async () => {
    const { server } = createServer(
      {
        ZENDESK_SUBDOMAIN: 'acme',
        ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
        ZENDESK_OAUTH_CALLBACK_PORT: String(freePort()),
        CLAUDE_PLUGIN_DATA: tempDir(),
      },
      { security: keychain() },
    );
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'diag', version: '0.0.0' }, { capabilities: { roots: {} } });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    try {
      const result = (await client.callTool({ name: 'zendesk_diagnostics', arguments: {} })) as {
        content: { text?: string }[];
      };
      const text = result.content.map((c) => c.text ?? '').join('\n');
      expect(text).toContain('client capabilities from initialize (verbatim):');
      expect(text).toContain('"roots"');
      expect(text).toContain('CLAUDE_PLUGIN_DATA: substituted');
    } finally {
      await client.close();
    }
  });

  it('is offered even when the plugin started with no configuration at all', async () => {
    const { server } = createServer({ CLAUDE_PLUGIN_DATA: tempDir() }, { security: keychain() });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'diag-unconfigured', version: '0.0.0' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('zendesk_diagnostics');
    } finally {
      await client.close();
    }
  });
});
