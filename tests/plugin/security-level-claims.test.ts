// tests/plugin/security-level-claims.test.ts
// #59 acceptance test 2, re-aimed by the owner decision of 2026-10-06: the installed plugin offers no
// way to choose the screening level, and no shipped text may say it does.
//
// The fact is asked of the manifest and the server: no settings dialog, and no server env through
// which an operator answer reaches the level createServer runs at. The README is where the claim is
// made in words, so there the words ARE the contract: the two passages that speak about the level are
// pinned whole (whitespace-normalised, so a rewrap is free), with the level taken from the server, and
// no other README text may speak about it or name a level (text oracle T2, round 3, 2026-10-15). The
// other texts the release ships (every member of release.yml's one-line `- run: zip -MM -r <archive> <members>`
// step) may not speak about it either.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, SECURITY_LEVELS } from '../../src/server.js';
import type { RunSecurity } from '../../src/auth/store-key.js';
import { keychain, TOKEN_STORE_ACCOUNT } from '../auth/keychain.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const readme = read('README.md');
const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const row = readme.split('\n').find((l) => l.startsWith('| `security_level` |'));
const bullet = readme.slice(readme.indexOf('- **Prompt-injection screening.**')).split('\n- **')[0];

const contractRow = (level: string) =>
  `| \`security_level\` | \`${level}\` | no | Prompt-injection screening. Fixed at \`${level}\` in the installed plugin — only a hand-started server or a remote-connector deployment reads \`ZENDESK_SECURITY_LEVEL\`, see [Security](#security) |`;
const contractBullet = (level: string) =>
  `- **Prompt-injection screening.** Ticket/comment/user content is attacker-controllable; all inbound Zendesk content is screened and wrapped in session-scoped delimiters so the model treats it as data, not instructions. The level is **not selectable in the installed plugin**: it is fixed at \`${level}\`. \`ZENDESK_SECURITY_LEVEL\` (${SECURITY_LEVELS.map((l) => `\`${l}\``).join(' | ')}) is read only when the server is started by hand from a shell, or by a remote-connector deployment (deprioritised since 2026-09-23). At \`security_level=off\` the fence is dropped but forged delimiters are still stripped, patterns are still detected, and every tool result says screening is off.`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function runsAt(extra: Record<string, string>, security: RunSecurity = keychain()) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-level-claims-'));
  dirs.push(dataDir);
  const env = { ZENDESK_SUBDOMAIN: 'acme', ZENDESK_OAUTH_CLIENT_ID: 'client-abc', ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz', ZENDESK_DATA_DIR: dataDir, ...extra };
  return createServer(env, { security }).ctx.securityLevel;
}

describe('the installed plugin offers no way to choose the security level, and no shipped text says it does (#59)', () => {
  it('the probe reads the level the server really runs at, not a constant', () => {
    expect(runsAt({ ZENDESK_SECURITY_LEVEL: 'off' })).toBe('off');
    expect(runsAt({})).toBe('standard');
  });

  // Every level, not just `off`: a store that may only tighten the level is a choice too.
  it('no Keychain account the server reads reaches the level', () => {
    for (const level of SECURITY_LEVELS) {
      const everyAccount: RunSecurity = (args, input) =>
        args[0] === 'find-generic-password' && args[args.indexOf('-a') + 1] !== TOKEN_STORE_ACCOUNT ? { status: 0, output: `${level}\n` } : keychain()(args, input);
      expect(runsAt({}, everyAccount), `every account answers ${level}`).toBe(runsAt({}));
    }
  });

  // Every server, under whatever key, with every operator answer set to `off`: a server env that
  // only carries the subdomain stays green, one that reaches the level does not.
  it('the plugin manifest declares no settings dialog and no server env that reaches the level', () => {
    expect(manifest.userConfig, '.claude-plugin/plugin.json declares a settings dialog').toBeUndefined();
    expect(existsSync(join(root, '.mcp.json')), 'a root .mcp.json is a second server source').toBe(false);
    expect(manifest.mcpServers?.constructor, 'mcpServers is inline in .claude-plugin/plugin.json').toBe(Object);
    const servers = Object.entries(manifest.mcpServers as Record<string, { env?: Record<string, string> }>);
    expect(servers, '.claude-plugin/plugin.json declares no server').not.toHaveLength(0);
    for (const [name, server] of servers) {
      const answered = Object.fromEntries(Object.entries(server?.env ?? {}).map(([k, v]) => [k, String(v).replace(/\$\{user_config\.[^}]+\}/g, 'off')]));
      expect(runsAt(answered), `mcpServers.${name}: an operator answer reaches the level`).toBe(runsAt({}));
    }
  });

  it('the README configuration-table row is the contract row', () => {
    expect(flat(row ?? '')).toBe(flat(contractRow(runsAt({}))));
  });

  it('the README Security bullet is the contract bullet', () => {
    expect(flat(bullet)).toBe(flat(contractBullet(runsAt({}))));
  });

  // Every level name is reserved in README prose, even as a plain English word ("hand off"); (?<!-)
  // spares only the `--strict` flag of `claude plugin validate`.
  it('no other README text speaks about the security level or names a level', () => {
    const rest = readme.replace(row ?? '', '').replace(bullet, '');
    const re = new RegExp(`security[\\s_-]?level|(?<!-)\\b(${SECURITY_LEVELS.join('|')})\\b`, 'i');
    expect(rest.match(re)?.[0], 'README outside the two pinned passages').toBeUndefined();
  });

  // The members are read from release.yml's one-line `- run: zip -MM -r <archive> <members>` step, so a
  // newly shipped path is scanned without an edit here; any other form of that step (folded, continued,
  // commented, extra flags) fails at the parse instead of shrinking the scan. README.md has the cases
  // above, dist/plugin is the server itself. A bare level name stays free ("hand off"), a backticked one does not.
  it('no other shipped text speaks about the security level or names a level in backticks', () => {
    const zip = (read('.github/workflows/release.yml').match(/^ *- run: zip -MM -r \S+ (.+)$/m)?.[1] ?? '').trim().split(/\s+/);
    expect(zip, 'release.yml zip line').toContain('.claude-plugin');
    for (const m of zip) expect(existsSync(join(root, m)), `release.yml zip member ${m}`).toBe(true);
    const re = new RegExp(`security[\\s_-]?level|\`(${SECURITY_LEVELS.join('|')})\``, 'i');
    for (const member of zip.filter((m) => m !== 'README.md' && m !== 'dist/plugin')) {
      const files = statSync(join(root, member)).isFile()
        ? [member]
        : readdirSync(join(root, member), { recursive: true, withFileTypes: true })
            .filter((f) => f.isFile())
            .map((f) => relative(root, join(f.parentPath ?? (f as unknown as { path: string }).path, f.name)));
      for (const rel of files) expect(read(rel).match(re)?.[0], rel).toBeUndefined();
    }
  });
});
