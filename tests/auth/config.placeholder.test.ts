import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuthConfig, USER_CONFIG_FIELD_BY_ENV } from '../../src/auth/config.js';
import { keychain } from './keychain.js';
import { createServer } from '../../src/server.js';

// The MCPB host substitutes ${user_config.x} only for values it actually has: an optional field the
// user left blank is passed through as the LITERAL placeholder string
// (@anthropic-ai/mcpb@2.1.2 dist/shared/config.js:16-27). Treat that as "absent".
const fullEnv = (): NodeJS.ProcessEnv => ({
  ZENDESK_SUBDOMAIN: 'acme',
  ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
  ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
  ZENDESK_DATA_DIR: '/var/data',
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// createServer touches the filesystem (response cache), so it needs a writable data dir.
function serverEnv(): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-placeholder-'));
  dirs.push(dataDir);
  // ZENDESK_SECURITY_LEVEL is set so the #93 absence notice never fires in this suite: its subject
  // is ZENDESK_MARKDOWN_CONVERSION, and the cases below assert that NOTHING warned, which is a
  // stronger claim than filtering the warnings down to the ones they expected.
  return { ...fullEnv(), ZENDESK_DATA_DIR: dataDir, ZENDESK_SECURITY_LEVEL: 'standard' };
}

describe('unsubstituted ${user_config.*} placeholders', () => {
  it('an optional placeholder port falls back to 8976 instead of NaN', () => {
    const { config } = resolveAuthConfig({
      ...fullEnv(),
      ZENDESK_OAUTH_CALLBACK_PORT: '${user_config.oauth_callback_port}',
    }, keychain());
    expect(config.callbackPort).toBe(8976);
    expect(Number.isNaN(config.callbackPort)).toBe(false);
  });

  it('a placeholder ZENDESK_DATA_DIR does not become a literal directory name', () => {
    const { dataDir } = resolveAuthConfig({
      ...fullEnv(),
      ZENDESK_DATA_DIR: '${user_config.data_dir}',
    }, keychain());
    expect(dataDir).not.toContain('${');
  });

  it.each(['ZENDESK_SUBDOMAIN', 'ZENDESK_OAUTH_CLIENT_ID'])(
    'a required %s left as a placeholder fails loudly and names the config field',
    (name) => {
      const env = { ...fullEnv(), [name]: `\${user_config.${USER_CONFIG_FIELD_BY_ENV[name]}}` };
      expect(() => resolveAuthConfig(env, keychain())).toThrow(USER_CONFIG_FIELD_BY_ENV[name]);
    },
  );

  // The client secret is no longer required (#68), so the placeholder it may arrive as must read as
  // "absent" — not as a secret literally called "${user_config.oauth_client_secret}", which Zendesk
  // would refuse with a 401 nobody could explain.
  it('a placeholder client secret reads as absent rather than as a secret', () => {
    const { config } = resolveAuthConfig(
      { ...fullEnv(), ZENDESK_OAUTH_CLIENT_SECRET: '${user_config.oauth_client_secret}' },
      keychain(),
    );
    expect(config.clientSecret).toBeUndefined();
  });

  // console.warn is silenced here: an unsubstituted ZENDESK_SECURITY_LEVEL re-fires the #93
  // absence notice, and an unmocked one prints to the suite's stderr with no case attached to it.
  it('a placeholder security level and markdown flag fall back to the shipped defaults', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx } = createServer({
      ...serverEnv(),
      ZENDESK_SECURITY_LEVEL: '${user_config.security_level}',
      ZENDESK_MARKDOWN_CONVERSION: '${user_config.markdown_conversion}',
    }, { security: keychain() });
    warn.mockRestore();
    expect(ctx.securityLevel).toBe('standard');
    expect(ctx.markdownDefault).toBe(true);
  });

  it('a stringified boolean "false" still disables markdown conversion', () => {
    const { ctx } = createServer({ ...serverEnv(), ZENDESK_MARKDOWN_CONVERSION: 'false' }, { security: keychain() });
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
    const { ctx } = createServer(env, { security: keychain() });
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
    // …and no configuration field, same as the screening level: the installed plugin declares none.
    expect(warnings[0]).not.toContain('configuration field');
  });

  it('stays silent and true when the variable is absent', () => {
    const { markdownDefault, warnings } = build();
    expect(markdownDefault).toBe(true);
    expect(warnings).toEqual([]);
  });
});
