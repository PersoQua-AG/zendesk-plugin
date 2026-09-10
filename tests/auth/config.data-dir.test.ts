import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { defaultDataDir, resolveAuthConfig } from '../../src/auth/config.js';

const fullEnv = (): NodeJS.ProcessEnv => ({
  ZENDESK_SUBDOMAIN: 'acme',
  ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
  ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
});

describe('defaultDataDir', () => {
  it('is an absolute path outside the current working directory', () => {
    const dir = defaultDataDir({}, 'darwin');
    expect(isAbsolute(dir)).toBe(true);
    expect(dir.startsWith(process.cwd())).toBe(false);
  });

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
    const { dataDir, tokensPath } = resolveAuthConfig(fullEnv());
    expect(dataDir).toBe(defaultDataDir(fullEnv()));
    expect(isAbsolute(dataDir)).toBe(true);
    expect(tokensPath).toBe(`${dataDir}/tokens.enc`);
  });

  it('still honors an explicit absolute CLAUDE_PLUGIN_DATA (Claude Code plugin path)', () => {
    const { dataDir, tokensPath } = resolveAuthConfig({ ...fullEnv(), CLAUDE_PLUGIN_DATA: '/var/data' });
    expect(dataDir).toBe('/var/data');
    expect(tokensPath).toBe('/var/data/tokens.enc');
  });

  it('treats an empty-string CLAUDE_PLUGIN_DATA as absent', () => {
    expect(resolveAuthConfig({ ...fullEnv(), CLAUDE_PLUGIN_DATA: '' }).dataDir).toBe(
      defaultDataDir(fullEnv()),
    );
  });
});
