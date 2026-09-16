import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir, USER_CONFIG_FIELD_BY_ENV } from '../../src/auth/config.js';
import { SECURITY_LEVELS } from '../../src/server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

const manifest = read('manifest.json');
const plugin = read('.claude-plugin/plugin.json');
const pkg = read('package.json');

type UserConfigEntry = {
  type: string;
  title: string;
  description: string;
  required?: boolean;
  default?: unknown;
  sensitive?: boolean;
  min?: number;
  max?: number;
};

const userConfig: Record<string, UserConfigEntry> = manifest.user_config;
const serverEnv: Record<string, string> = manifest.server.mcp_config.env;

// Copied by hand from the MCPB manifest schema, because @anthropic-ai/mcpb is NOT a dependency of
// this package (owner decision D7: CI runs neither `mcpb validate` nor `mcpb pack`, so a test that
// reaches for it through npx would depend on the network and on the runner's npx cache). A copy is
// therefore the only form this can take here, and it is checked by hand against the source below.
//
// Source, verified 2026-09-16 against @anthropic-ai/mcpb@2.1.2 as published on npm: the file lies in
// the package under BOTH schemas/mcpb-manifest-v0.3.schema.json and
// dist/mcpb-manifest-v0.3.schema.json (its package.json "files" is ["dist", "schemas"]; the two
// files are byte-identical, `diff -q` reports no difference). At
// properties.user_config.additionalProperties it declares exactly the nine property names below,
// sets "additionalProperties": false, gives properties.type the five-value enum below, and types
// both "min" and "max" as numbers. To re-verify:
//
//   npm pack @anthropic-ai/mcpb@2.1.2 && tar xzf anthropic-ai-mcpb-2.1.2.tgz
//   node -e 'const u=require("./package/schemas/mcpb-manifest-v0.3.schema.json")
//     .properties.user_config.additionalProperties;
//     console.log(Object.keys(u.properties), u.additionalProperties, u.properties.type.enum)'
const ALLOWED_USER_CONFIG_KEYS = ['type', 'title', 'description', 'required', 'default', 'multiple', 'sensitive', 'min', 'max'];
const ALLOWED_TYPES = ['string', 'number', 'boolean', 'directory', 'file'];

describe('MCPB manifest shape', () => {
  it('declares manifest_version 0.3 and every required top-level field', () => {
    expect(manifest.manifest_version).toBe('0.3');
    for (const key of ['name', 'version', 'description', 'author', 'server']) {
      expect(manifest[key], key).toBeTruthy();
    }
    expect(manifest.author.name).toBeTruthy();
  });

  it('runs the compiled stdio server from the unpacked extension directory', () => {
    expect(manifest.server.type).toBe('node');
    expect(manifest.server.entry_point).toBe('dist/server.js');
    expect(manifest.server.mcp_config.command).toBe('node');
    expect(manifest.server.mcp_config.args).toEqual(['${__dirname}/dist/server.js']);
  });

  it('declares a node runtime no newer than package.json engines and only real platforms', () => {
    expect(manifest.compatibility.runtimes.node).toBe(pkg.engines.node);
    for (const p of manifest.compatibility.platforms) expect(['darwin', 'win32', 'linux']).toContain(p);
  });

  // The manifest promises a platform; defaultDataDir must have a home for it. Declaring one without
  // the other is how tokens.enc ends up in an arbitrary working directory on the platform nobody
  // tested — the failure the absolute-path rule exists to prevent. Driven off the manifest, so
  // adding a platform there without a branch in config.ts fails here instead of in the field.
  it.each(manifest.compatibility.platforms as NodeJS.Platform[])(
    'resolves an absolute per-user data dir on every declared platform: %s',
    (platform) => {
      const dir = defaultDataDir({}, platform);
      expect(isAbsolute(dir), `${platform} → ${dir}`).toBe(true);
      expect(dir.startsWith(process.cwd())).toBe(false);
      expect(dir.endsWith('zendesk-plugin')).toBe(true);
    },
  );

  it('keeps its version and identity in sync with the Claude Code plugin manifest', () => {
    expect(manifest.name).toBe(plugin.name);
    expect(manifest.version).toBe(plugin.version);
  });
});

describe('MCPB user_config', () => {
  it('exposes exactly the same configuration keys as the Claude Code plugin manifest', () => {
    expect(Object.keys(userConfig).sort()).toEqual(Object.keys(plugin.userConfig).sort());
  });

  it('uses the same type, required flag and value bounds for every key as the plugin manifest', () => {
    for (const [key, entry] of Object.entries(userConfig)) {
      const mirror = plugin.userConfig[key] as UserConfigEntry;
      expect(entry.type, key).toBe(mirror.type);
      expect(Boolean(entry.required), key).toBe(Boolean(mirror.required));
      // Bounds are what a host refuses a value by. Declared on one manifest only, the two hosts
      // would disagree about which values ever reach the server.
      expect(entry.min, `${key}.min`).toBe(mirror.min);
      expect(entry.max, `${key}.max`).toBe(mirror.max);
    }
  });

  // That the bounds MATCH the server's range is asserted against the code constants, in both
  // manifests, in tests/auth/config.callback-port.test.ts:62-71. What is left here is the claim that
  // file cannot make: the port is the only field that carries bounds at all.
  it('bounds the callback port, and it is the only field that carries bounds', () => {
    const bounded = Object.entries(userConfig).filter(([, e]) => e.min !== undefined || e.max !== undefined);
    expect(bounded.map(([k]) => k)).toEqual(['oauth_callback_port']);
  });

  // security_level is an enumeration in fact but cannot be declared as one: the MCPB v0.3 user_config
  // entry schema (@anthropic-ai/mcpb@2.1.2 schemas/mcpb-manifest-v0.3.schema.json) lists exactly the
  // nine keys in ALLOWED_USER_CONFIG_KEYS and sets "additionalProperties": false — there is no "enum",
  // and "min"/"max" are numbers, so they cannot bound a string either. A host therefore cannot refuse
  // a mistyped level in the settings dialog the way it refuses an out-of-range port; the server has
  // to catch it, which is what parseSecurityLevel does. The description is the only place the manifest
  // can state the accepted values, so it is pinned to the code's list rather than left to drift.
  // No assertion stands in for the schema claim above: ALLOWED_USER_CONFIG_KEYS is the hand copy
  // itself, so `expect(ALLOWED_USER_CONFIG_KEYS).not.toContain('enum')` would only measure the copy
  // against itself and could never fail. The claim's evidence is the source note at the top of this
  // file; what IS asserted below is what the manifests actually do about it.
  it('cannot declare an enum, so it names the accepted security levels in the description instead', () => {
    for (const entry of [userConfig.security_level, plugin.userConfig.security_level as UserConfigEntry]) {
      expect(Object.keys(entry)).not.toContain('enum');
      expect(entry.description).toContain(SECURITY_LEVELS.join(' | '));
    }
    expect(userConfig.security_level.description).toBe(plugin.userConfig.security_level.description);
    expect(SECURITY_LEVELS).toContain(userConfig.security_level.default);
  });

  it('carries only schema-known fields, a valid type, and a title + description on every key', () => {
    for (const [key, entry] of Object.entries(userConfig)) {
      expect(ALLOWED_TYPES, key).toContain(entry.type);
      expect(entry.title, key).toBeTruthy();
      expect(entry.description, key).toBeTruthy();
      for (const field of Object.keys(entry)) expect(ALLOWED_USER_CONFIG_KEYS, `${key}.${field}`).toContain(field);
    }
  });

  it('marks the client secret sensitive, and only the client secret', () => {
    const sensitive = Object.entries(userConfig).filter(([, e]) => e.sensitive).map(([k]) => k);
    expect(sensitive).toEqual(['oauth_client_secret']);
  });

  it('requires exactly subdomain + client id + client secret', () => {
    const required = Object.entries(userConfig).filter(([, e]) => e.required).map(([k]) => k).sort();
    expect(required).toEqual(['oauth_client_id', 'oauth_client_secret', 'zendesk_subdomain']);
  });

  it('pre-configures nothing beyond the defaults the server already applies in code', () => {
    const defaults = Object.fromEntries(
      Object.entries(userConfig).filter(([, e]) => e.default !== undefined).map(([k, e]) => [k, e.default]),
    );
    expect(defaults).toEqual({ security_level: 'standard', markdown_conversion: true, oauth_callback_port: 8976 });
  });
});

describe('MCPB env mapping', () => {
  it('maps every env var the server reads to its user_config field', () => {
    for (const [envName, field] of Object.entries(USER_CONFIG_FIELD_BY_ENV)) {
      expect(serverEnv[envName], envName).toBe(`\${user_config.${field}}`);
      expect(userConfig[field], field).toBeDefined();
    }
  });

  it('passes no env var that is not backed by a user_config field', () => {
    expect(Object.keys(serverEnv).sort()).toEqual(Object.keys(USER_CONFIG_FIELD_BY_ENV).sort());
  });

  it('does not set CLAUDE_PLUGIN_DATA — the server derives a stable per-user data dir itself', () => {
    expect(serverEnv.CLAUDE_PLUGIN_DATA).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain('CLAUDE_PLUGIN_DATA');
  });

  // The same env map has to be mirrored in .claude-plugin/plugin.json, which a different host
  // loads. Without this, a new config field costs five edits and only four of them are covered.
  it('the Claude Code plugin manifest passes the same env vars, plus CLAUDE_PLUGIN_DATA', () => {
    const pluginEnv: Record<string, string> = plugin.mcpServers.zendesk.env;
    for (const [envName, field] of Object.entries(USER_CONFIG_FIELD_BY_ENV)) {
      expect(pluginEnv[envName], envName).toBe(`\${user_config.${field}}`);
    }
    // CLAUDE_PLUGIN_DATA is the one known extra: Claude Code owns the plugin data dir, an MCPB
    // host does not (see the test right above).
    expect(Object.keys(pluginEnv).sort()).toEqual(
      [...Object.keys(USER_CONFIG_FIELD_BY_ENV), 'CLAUDE_PLUGIN_DATA'].sort(),
    );
  });

  it('ships no Zendesk instance data: no ids, no view/group/form/field pre-configuration', () => {
    const text = JSON.stringify(manifest);
    expect(text).not.toMatch(/"\w*_id"\s*:\s*\d/);
    expect(text).not.toMatch(/\b(view_id|group_id|ticket_form_id|custom_field_id|brand_id)\b/);
  });
});
