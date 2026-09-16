import { describe, it, expect, afterEach, vi } from 'vitest';
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

// `raw !== 'false'` read 'False', 'FALSE' and 'false ' as TRUE — the opposite of what was typed,
// with nothing said. Same class as the security level, and the same remedy: normalize the
// copy-paste artifacts, warn about anything still unreadable. The direction differs, and the cases
// below pin that difference: there is no safer side here, so an unreadable value falls back to the
// value both manifests declare (true) rather than being read as a "no".
describe('markdown conversion — an unreadable value is never read as a silent "no"', () => {
  function build(value?: string) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = serverEnv();
    if (value !== undefined) env.ZENDESK_MARKDOWN_CONVERSION = value;
    const { ctx } = createServer(env);
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    return { markdownDefault: ctx.markdownDefault, warnings };
  }

  it.each([
    ['exactly true', 'true', true],
    ['exactly false', 'false', false],
    ['capitalized, the shape a settings dialog produces', 'False', false],
    ['shouted', 'FALSE', false],
    ['with a trailing space from a copy-paste', 'false ', false],
    ['with surrounding whitespace', '  true  ', true],
  ])('accepts %s (%s) without a warning', (_label, value, expected) => {
    const { markdownDefault, warnings } = build(value);
    expect(markdownDefault).toBe(expected);
    expect(warnings).toEqual([]);
  });

  it.each([
    ['a typo', 'flase'],
    ['a synonym that is not the value', 'no'],
    ['a numeric value', '0'],
    ['a word that is not a boolean at all', 'maybe'],
  ])('warns and keeps the declared default for %s: %s', (_label, value) => {
    const { markdownDefault, warnings } = build(value);
    expect(markdownDefault).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`ZENDESK_MARKDOWN_CONVERSION "${value}"`);
    expect(warnings[0]).toContain('"markdown_conversion"');
  });

  it('stays silent and true when the variable is absent', () => {
    const { markdownDefault, warnings } = build();
    expect(markdownDefault).toBe(true);
    expect(warnings).toEqual([]);
  });
});
