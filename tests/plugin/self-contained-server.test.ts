import { describe, it, expect, afterAll, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { CONFIG_ACCOUNTS } from '../../src/auth/store-key.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { fakeKeychain, keychain, TOKEN_STORE_ACCOUNT } from '../auth/keychain.js';
import { fenceProcesses } from './process-fence.js';
import { gitEnv } from '../setup/git-env.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Realpathed so the launch is not through a symlink (macOS tmpdir is /var -> /private/var).
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'zd-plugin-copy-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// What an install receives: the tracked files, so node_modules/ and uncommitted build output are out.
function copyPluginPayload(dest: string): void {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', env: gitEnv() })
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    mkdirSync(dirname(join(dest, file)), { recursive: true });
    cpSync(join(root, file), join(dest, file));
  }
}

// A CHILD cannot be given the fake Keychain runner — it is a separate process running the shipped bundle —
// and for a while this test's child created the real `zendesk-plugin/token-store-key` on every run of the
// suite, which no source-parsing guard can see (tests/setup/no-real-keychain.ts now does).
//
// So it is spawned in the one state that needs no key at all: no subdomain, so resolveAuthConfig throws
// before the lazily-read key, and a ZENDESK_DATA_DIR that is a FILE, so the cache cannot be opened and
// the first-run setup gate is skipped too. The subject of this test is unaffected — whether the bundle the
// manifest launches runs at all, and whether it registers the same tools as this process — because the tool
// surface is registered whatever the configuration says. What the child can no longer prove, that the
// bundler kept the Keychain path, the case below drives in this process.
function keylessEnv(dataDirAsFile: string): Record<string, string> {
  return { ZENDESK_DATA_DIR: dataDirAsFile };
}

function fileNotDirectory(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  return path;
}

async function inProcessToolNames(env: Record<string, string>): Promise<string[]> {
  const { server } = createServer(env, { security: keychain() });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'expected', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name).sort();
}

describe('plugin server from a copy without node_modules', () => {
  // Raw stdio, because the SDK Client silently drops a second response to the same id.
  it('starts the entry plugin.json launches and answers each request exactly once', async () => {
    const pluginRoot = join(scratch, 'plugin');
    copyPluginPayload(pluginRoot);
    const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    const { command, args } = manifest.mcpServers.zendesk as { command: string; args: string[] };
    const child = spawn(
      command === 'node' ? process.execPath : command,
      args.map((a) => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)),
      {
        cwd: pluginRoot,
        env: keylessEnv(fileNotDirectory(join(scratch, 'data-child'))),
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    );
    const messages: { id?: number; result?: { tools: { name: string }[] } }[] = [];
    createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)));
    const send = (msg: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    try {
      send({
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plugin-copy', version: '0.0.0' } },
      });
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/list' });
      await vi.waitFor(() => expect(messages.some((m) => m.id === 2)).toBe(true), { timeout: 20_000, interval: 50 });
      await delay(500);
    } finally {
      child.kill();
    }

    expect(messages.filter((m) => m.id !== undefined).map((m) => m.id)).toEqual([1, 2]);
    const names = messages.find((m) => m.id === 2)!.result!.tools.map((t) => t.name).sort();
    const expected = await inProcessToolNames(keylessEnv(fileNotDirectory(join(scratch, 'data-expected'))));
    expect(expected.length).toBeGreaterThan(0);
    expect(names).toEqual(expected);
  }, 60_000);

  // The bundle's timers and servers outlive the case, so the fence stays up until the file ends: after the
  // window it refuses every call, the real `/usr/bin/security` included, and records it for afterAll.
  const unexpected: string[] = [];
  let fence: { opened: string[]; restore: () => void } | undefined;
  afterAll(() => {
    fence?.restore();
    expect([...unexpected, ...(fence?.opened ?? [])]).toEqual([]);
  });

  // What the child used to prove by doing it, and now must not: that the bundler kept the Keychain path.
  // So the bundle is driven, not read: its createServer runs its own runSecurity inside the process fence,
  // where, inside the window, execFileSync of `/usr/bin/security` lands in the fake Keychain and every other
  // route the fence knows is refused, checked before the bundle loads. A first start must write a key through
  // stdin, and a second start must read that same key back and decrypt tokens with it.
  it('keeps the Keychain path in the bundle the manifest launches', async () => {
    const fake = fakeKeychain();
    let closed = false;
    const { opened } = (fence = await fenceProcesses((name, bin, args, options) => {
      const o = (options ?? {}) as { input?: unknown; encoding?: string; stdio?: unknown };
      if (closed || name !== 'execFileSync' || bin !== '/usr/bin/security') {
        unexpected.push(`${closed ? 'after the window: ' : ''}${name}(${String(bin)})`);
        throw new Error(`unexpected child_process call: ${name}(${String(bin)})`);
      }
      const { status, output } = fake.run(args as string[], String(o.input ?? ''));
      if (status !== 0) throw Object.assign(new Error(`security exited ${status}`), { status });
      // Node's contract: no stdout unless it is piped, and a Buffer unless a string encoding was asked for.
      if (((Array.isArray(o.stdio) ? o.stdio[1] : o.stdio) ?? 'pipe') !== 'pipe') return null;
      return o.encoding && o.encoding !== 'buffer' ? output : Buffer.from(output);
    }));
    const requests: string[] = [];
    try {
      const dataDir = mkdtempSync(join(scratch, 'data-bundle-'));
      const bundle = await import(join(root, 'dist', 'plugin', 'server.js'));
      bundle.createServer({ ZENDESK_DATA_DIR: dataDir });
      expect([...unexpected, ...opened]).toEqual([]);
      const key = fake.items.get(TOKEN_STORE_ACCOUNT) as string;
      expect(Buffer.from(key ?? '', 'base64')).toHaveLength(32);

      for (const account of Object.values(CONFIG_ACCOUNTS)) fake.items.set(account, `stored-${account}`);
      new TokenStore(join(dataDir, 'tokens.enc'), key).save({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000 });
      const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
        requests.push(`${input} ${new Headers(init?.headers).get('authorization')}`);
        return Response.json({ user: { id: 1, name: 'Agent', email: 'agent@acme.test', role: 'admin' } });
      }) as unknown as typeof fetch;
      const { server } = bundle.createServer({ ZENDESK_DATA_DIR: dataDir }, { fetchImpl });
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'bundle', version: '0.0.0' });
      await Promise.all([server.connect(serverT), client.connect(clientT)]);
      await client.callTool({ name: 'zendesk_get_me', arguments: {} });
      await client.close();
    } finally {
      // Deferred work lands in the fake, where the transcript below sees it, until the bundle goes quiet.
      let n;
      do {
        n = fake.calls.length;
        await delay(0);
        await new Promise((r) => setImmediate(r));
      } while (n !== fake.calls.length);
      closed = true;
    }

    expect(requests).toEqual(['https://stored-oauth-subdomain.zendesk.com/api/v2/users/me.json Bearer at-1']);
    const find = (account: string) => ['find-generic-password', '-s', 'zendesk-plugin', '-a', account, '-w'];
    const config = Object.values(CONFIG_ACCOUNTS).map(find);
    // The stdin form, because an argv form would put the key in `ps`; the fake also demands it twice.
    const add = ['add-generic-password', '-s', 'zendesk-plugin', '-a', TOKEN_STORE_ACCOUNT, '-U', '-w'];
    // The order and arguments of what touches the key, and a read of each config item; not how often the
    // config is read, which a cache may change.
    const argv = fake.calls.map((c) => c.args);
    expect(argv.filter((a) => a.includes(TOKEN_STORE_ACCOUNT))).toEqual([find(TOKEN_STORE_ACCOUNT), add, find(TOKEN_STORE_ACCOUNT)]);
    expect(argv).toEqual(expect.arrayContaining(config));
    for (const a of argv) expect([...config, find(TOKEN_STORE_ACCOUNT), add]).toContainEqual(a);
    expect([...unexpected, ...opened]).toEqual([]);
  });
});
