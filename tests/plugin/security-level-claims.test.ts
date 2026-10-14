// tests/plugin/security-level-claims.test.ts
// #59 acceptance test 2, re-aimed by the owner decision of 2026-10-06: no shipped text may promise
// a selectable screening level, because the shipped plugin offers none.
//
// The truth is asked of the server, not of a sentence: createServer is started with the env the
// installed plugin's manifest hands it, every operator answer set to `off`, and the level it runs at
// is what the README may name. Each text is then read only for which of SECURITY_LEVELS it offers —
// a wording that says "fixed" or not is neither here nor there (text oracle T2, 2026-10-14).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, SECURITY_LEVELS } from '../../src/server.js';
import { keychain } from '../auth/keychain.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const readme = read('README.md');
const securitySection = readme.slice(readme.indexOf('- **Prompt-injection screening.**')).split('\n- **')[0];

const levelsNamed = (text: string) => SECURITY_LEVELS.filter((l) => new RegExp(`\\b${l}\\b`).test(text));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function runsAt(extra: Record<string, string>) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-level-claims-'));
  dirs.push(dataDir);
  const env = { ZENDESK_SUBDOMAIN: 'acme', ZENDESK_OAUTH_CLIENT_ID: 'client-abc', ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz', ZENDESK_DATA_DIR: dataDir, ...extra };
  return createServer(env, { security: keychain() }).ctx.securityLevel;
}

// Whatever dialog the manifest declares, under whatever key spelling, the operator picks `off`.
const installedLevel = () => {
  const env: Record<string, unknown> = JSON.parse(read('.claude-plugin/plugin.json')).mcpServers.zendesk.env ?? {};
  return runsAt(Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v).replace(/\$\{user_config\.[^}]+\}/g, 'off')])));
};

describe('no shipped text promises a security level the plugin does not offer (#59)', () => {
  it('the probe reads the level the server really runs at, not a constant', () => {
    expect(runsAt({ ZENDESK_SECURITY_LEVEL: 'off' })).toBe('off');
    expect(runsAt({})).toBe('standard');
  });

  it('the installed plugin gives the operator no way to change the level', () => {
    expect(installedLevel(), '.claude-plugin/plugin.json lets an operator answer reach the level').toBe(runsAt({}));
  });

  it('the README configuration table offers only the level the installed plugin runs at', () => {
    const row = readme.split('\n').find((l) => l.startsWith('|') && l.split('|')[1].replace(/[^a-z]/gi, '').toLowerCase() === 'securitylevel');
    expect(row, 'README configuration table has no security_level row').toBeDefined();
    expect(levelsNamed(row ?? '')).toEqual([runsAt({})]);
  });

  it('the README Security section, before it names the hand-started variable, offers only the installed level', () => {
    expect(levelsNamed(securitySection.split('ZENDESK_SECURITY_LEVEL')[0])).toEqual([runsAt({})]);
  });

  // The two paths that CAN set it, named where the operator reads about it, so the withdrawal is a
  // correction and not just a deletion.
  it('the Security section names the only two paths that can still set a level', () => {
    expect(securitySection).toContain('ZENDESK_SECURITY_LEVEL');
    expect(securitySection).toContain('started by hand');
    expect(securitySection).toContain('remote-connector');
  });
});
