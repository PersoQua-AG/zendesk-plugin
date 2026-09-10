import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_CONFIG_FIELD_BY_ENV } from '../../src/auth/config.js';

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
};

const userConfig: Record<string, UserConfigEntry> = manifest.user_config;
const serverEnv: Record<string, string> = manifest.server.mcp_config.env;

// Field names taken verbatim from @anthropic-ai/mcpb@2.1.2 schemas/mcpb-manifest-latest.schema.json.
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

  it('keeps its version and identity in sync with the Claude Code plugin manifest', () => {
    expect(manifest.name).toBe(plugin.name);
    expect(manifest.version).toBe(plugin.version);
  });
});

describe('MCPB user_config', () => {
  it('exposes exactly the same configuration keys as the Claude Code plugin manifest', () => {
    expect(Object.keys(userConfig).sort()).toEqual(Object.keys(plugin.userConfig).sort());
  });

  it('uses the same type and required flag for every key as the plugin manifest', () => {
    for (const [key, entry] of Object.entries(userConfig)) {
      const mirror = plugin.userConfig[key] as UserConfigEntry;
      expect(entry.type, key).toBe(mirror.type);
      expect(Boolean(entry.required), key).toBe(Boolean(mirror.required));
    }
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
