import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { dataDirOf, defaultDataDir, resolveAuthConfig } from '../../src/auth/config.js';
import { keychain } from './keychain.js';

const fullEnv = (): NodeJS.ProcessEnv => ({
  ZENDESK_SUBDOMAIN: 'acme',
  ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
  ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
});

describe('defaultDataDir', () => {
  it('uses the macOS Application Support directory on darwin', () => {
    expect(defaultDataDir({}, 'darwin')).toBe(
      join(homedir(), 'Library', 'Application Support', 'zendesk-plugin'),
    );
  });

  it('uses APPDATA on win32 and falls back to the roaming profile', () => {
    expect(defaultDataDir({ APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }, 'win32')).toBe(
      join('C:\\Users\\t\\AppData\\Roaming', 'zendesk-plugin'),
    );
    expect(defaultDataDir({}, 'win32')).toBe(join(homedir(), 'AppData', 'Roaming', 'zendesk-plugin'));
  });

  it('honors XDG_DATA_HOME on linux and falls back to ~/.local/share', () => {
    expect(defaultDataDir({ XDG_DATA_HOME: '/xdg' }, 'linux')).toBe(join('/xdg', 'zendesk-plugin'));
    expect(defaultDataDir({}, 'linux')).toBe(join(homedir(), '.local', 'share', 'zendesk-plugin'));
  });
});

describe('resolveAuthConfig data dir', () => {
  it('defaults to the per-user data dir, not a cwd-relative folder', () => {
    const { dataDir, tokensPath } = resolveAuthConfig(fullEnv(), keychain());
    expect(dataDir).toBe(defaultDataDir(fullEnv()));
    expect(isAbsolute(dataDir)).toBe(true);
    expect(tokensPath).toBe(join(dataDir, 'tokens.enc'));
  });

  it('still honors an explicit absolute ZENDESK_DATA_DIR (Claude Code plugin path)', () => {
    const { dataDir, tokensPath } = resolveAuthConfig({ ...fullEnv(), ZENDESK_DATA_DIR: '/var/data' }, keychain());
    expect(dataDir).toBe('/var/data');
    expect(tokensPath).toBe(join('/var/data', 'tokens.enc'));
  });

  it('treats an empty-string ZENDESK_DATA_DIR as absent', () => {
    expect(resolveAuthConfig({ ...fullEnv(), ZENDESK_DATA_DIR: '' }, keychain()).dataDir).toBe(
      defaultDataDir(fullEnv()),
    );
  });
});

// The degraded startup path cannot reject a bad ZENDESK_DATA_DIR — it is already degrading — so it
// resolves one instead, and a relative value must not reach the cache or the token store either.
describe('dataDirOf, the fallback the degraded startup uses', () => {
  it('honours an absolute value and ignores anything else', () => {
    expect(dataDirOf({ ZENDESK_DATA_DIR: '/var/data' })).toBe('/var/data');
    expect(dataDirOf({ ZENDESK_DATA_DIR: 'relative/data' })).toBe(defaultDataDir({}));
    expect(dataDirOf({ ZENDESK_DATA_DIR: '' })).toBe(defaultDataDir({}));
    expect(dataDirOf({})).toBe(defaultDataDir({}));
  });
});

// #68 shipped the plugin manifest declaring CLAUDE_PLUGIN_DATA, which Claude Desktop reserves, so the
// server was dropped. Removing the declaration was only half of it: Claude Code INJECTS that variable
// per install, so a server that reads it resolves tokens.enc to one directory under Claude Code and
// another under Desktop, for the same account. Hence the rule these two guards pin together — the data
// directory has exactly one source, and CLAUDE_PLUGIN_DATA is not it.
const SRC = join(process.cwd(), 'src');
// Where the data directory is allowed to come from. Not a pattern over one call site: the file list is
// enumerated and compared whole, so a SECOND reader anywhere in src/ fails this rather than hiding.
const DIAGNOSTICS_ONLY = 'tools/diagnostics.ts';
// Reading the name in any of the shapes a reader actually uses. A mention in prose is not a read, which
// is why the env object has to be on the left.
const READS_IT = /(?:\w+\.)*(?:env|rawEnv)\s*(?:\.CLAUDE_PLUGIN_DATA\b|\[\s*['"`]CLAUDE_PLUGIN_DATA['"`]\s*\])/;

function srcFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map((p) => String(p).split('\\').join('/'))
    .filter((p) => p.endsWith('.ts'));
}

describe('CLAUDE_PLUGIN_DATA is not a source of the data directory', () => {
  it('is read in exactly one file, and only to REPORT what the host did with it', () => {
    const readers = srcFiles().filter((rel) => READS_IT.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(readers).toEqual([DIAGNOSTICS_ONLY]);
    // And that one reader cannot leak it into a path: it hands the value to substitutionState, which
    // answers with a state word, never the value.
    const report = readFileSync(join(SRC, DIAGNOSTICS_ONLY), 'utf8');
    expect(report).toContain('substitutionState(input.rawEnv.CLAUDE_PLUGIN_DATA)');
  });

  it('resolves the same directory whatever the host sets it to — all five cases', () => {
    const expected = defaultDataDir(fullEnv());
    const cases: NodeJS.ProcessEnv[] = [
      { CLAUDE_PLUGIN_DATA: '/host/injected/plugin/data' }, // what Claude Code injects
      {}, // unset, which is what the Desktop bridge leaves
      { CLAUDE_PLUGIN_DATA: '' },
      { CLAUDE_PLUGIN_DATA: 'relative/data' },
      { CLAUDE_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}' }, // the literal that reached the server before
    ];
    for (const extra of cases) {
      const env = { ...fullEnv(), ...extra };
      const resolved = resolveAuthConfig(env, keychain());
      expect(resolved.dataDir, JSON.stringify(extra)).toBe(expected);
      expect(resolved.tokensPath, JSON.stringify(extra)).toBe(join(expected, 'tokens.enc'));
      // The degraded path has to agree, or an incomplete configuration moves the token store.
      expect(dataDirOf(env), JSON.stringify(extra)).toBe(expected);
    }
  });
});
