import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuthConfig, USER_CONFIG_FIELD_BY_ENV } from '../../src/auth/config.js';
import { createServer } from '../../src/server.js';

// The MCPB host substitutes ${user_config.x} only for values it actually has: an optional field the
// user left blank is passed through as the LITERAL placeholder string
// (@anthropic-ai/mcpb@2.1.2 dist/shared/config.js:16-27). Treat that as "absent".
const fullEnv = (): NodeJS.ProcessEnv => ({
  ZENDESK_SUBDOMAIN: 'acme',
  ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
  ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
  CLAUDE_PLUGIN_DATA: '/var/data',
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// createServer touches the filesystem (response cache), so it needs a writable data dir.
function serverEnv(): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-placeholder-'));
  dirs.push(dataDir);
  return { ...fullEnv(), CLAUDE_PLUGIN_DATA: dataDir };
}

describe('unsubstituted ${user_config.*} placeholders', () => {
  it('an optional placeholder port falls back to 8976 instead of NaN', () => {
    const { config } = resolveAuthConfig({
      ...fullEnv(),
      ZENDESK_OAUTH_CALLBACK_PORT: '${user_config.oauth_callback_port}',
    });
    expect(config.callbackPort).toBe(8976);
    expect(Number.isNaN(config.callbackPort)).toBe(false);
  });

  it('a placeholder CLAUDE_PLUGIN_DATA does not become a literal directory name', () => {
    const { dataDir } = resolveAuthConfig({
      ...fullEnv(),
      CLAUDE_PLUGIN_DATA: '${user_config.data_dir}',
    });
    expect(dataDir).not.toContain('${');
  });

  it.each(['ZENDESK_SUBDOMAIN', 'ZENDESK_OAUTH_CLIENT_ID', 'ZENDESK_OAUTH_CLIENT_SECRET'])(
    'a required %s left as a placeholder fails loudly and names the config field',
    (name) => {
      const env = { ...fullEnv(), [name]: `\${user_config.${USER_CONFIG_FIELD_BY_ENV[name]}}` };
      expect(() => resolveAuthConfig(env)).toThrow(USER_CONFIG_FIELD_BY_ENV[name]);
    },
  );

  it('a placeholder security level and markdown flag fall back to the shipped defaults', () => {
    const { ctx } = createServer({
      ...serverEnv(),
      ZENDESK_SECURITY_LEVEL: '${user_config.security_level}',
      ZENDESK_MARKDOWN_CONVERSION: '${user_config.markdown_conversion}',
    });
    expect(ctx.securityLevel).toBe('standard');
    expect(ctx.markdownDefault).toBe(true);
  });

  it('a stringified boolean "false" still disables markdown conversion', () => {
    const { ctx } = createServer({ ...serverEnv(), ZENDESK_MARKDOWN_CONVERSION: 'false' });
    expect(ctx.markdownDefault).toBe(false);
  });
});
