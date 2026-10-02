// tests/plugin/claude-plugin-manifest.test.ts
// The Claude Code side of the manifest pair. It used to be asserted as a MIRROR of manifest.json in
// mcpb-manifest.test.ts; #68 ended that, because the two hosts do not read the same thing:
//
//   [PluginMcpHostConfig] Plugin "…" server "zendesk": config references plugin user configuration
//   (zendesk_subdomain, oauth_client_id, …) — user_config is not supported on the desktop host
//   bridge; dropping server
//
// Twenty of those lines in ~/Library/Logs/Claude/main.log is what "the plugin never starts" was. So
// the single most important property of this file is a NEGATIVE one, and it is asserted on the raw
// text rather than on the parsed object: not one `${user_config.` may appear anywhere in it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const raw = readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8');
const plugin = JSON.parse(raw);
const env: Record<string, string> = plugin.mcpServers.zendesk.env;

describe('the Claude Code plugin manifest', () => {
  it('references no plugin user configuration at all — the one line that dropped the server', () => {
    expect(raw).not.toContain('${user_config.');
    expect(plugin.userConfig).toBeUndefined();
  });

  it('passes CLAUDE_PLUGIN_DATA and nothing else', () => {
    // Claude Code owns the plugin data dir and substitutes this one itself; every other setting now
    // reaches the server as an ordinary environment variable or not at all, and the server starts in
    // its degraded mode and explains itself when it is not there.
    expect(env).toEqual({ CLAUDE_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}' });
  });

  it('still launches the bundled plugin server from the plugin root', () => {
    // ${CLAUDE_PLUGIN_ROOT} stays: it is substituted by the host, not by user configuration. The
    // entry point is the esbuild BUNDLE, which is a different file from the MCPB manifest's tsc
    // output (manifest.json → dist/server.js) on purpose.
    expect(plugin.mcpServers.zendesk.command).toBe('node');
    expect(plugin.mcpServers.zendesk.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/plugin/server.js']);
  });
});
