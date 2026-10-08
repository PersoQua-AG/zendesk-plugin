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
//
// #68 left one env entry behind and the same host dropped the server again, with a new line:
//
//   [PluginMcpHostConfig] Plugin "…" server "zendesk": failed to build host proxy target:
//   env declares reserved variable name "CLAUDE_PLUGIN_DATA"
//
// So the second negative property, and it is asserted as the strongest form available: there is no env
// block at all. That beats enumerating what the host reserves (95 exact names plus the CLAUDE_/GIT_/
// NPM_CONFIG_/… prefixes, minus three UV_ allowlist entries — re-derive by finding the string "reserved
// variable name" in Claude Desktop 2.19675.0's /Applications/Claude.app/Contents/Resources/app.asar),
// and it also forbids a name the host does NOT reserve, such as our own ZENDESK_DATA_DIR, whose whole
// point is that no manifest passes it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const raw = readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8');
const plugin = JSON.parse(raw);

describe('the Claude Code plugin manifest', () => {
  it('references no plugin user configuration at all — the one line that dropped the server', () => {
    expect(raw).not.toContain('${user_config.');
    expect(plugin.userConfig).toBeUndefined();
  });

  it('declares no env at all — the one line that dropped the server after #68', () => {
    expect(plugin.mcpServers.zendesk.env).toBeUndefined();
    // Named on the raw text too, so a reappearance anywhere — command, args, a second server — fails
    // here rather than only where it is read. The host sets this one itself (Claude Code injects it;
    // Desktop reserves the name), so declaring it was never a passthrough, only a rejection. Same
    // rationale as the MCPB side, tests/plugin/mcpb-manifest.test.ts.
    expect(raw).not.toContain('CLAUDE_PLUGIN_DATA');
    // And the data-dir override stays a test and operator seam: a manifest that passed it would
    // silently restore the per-host token directories this file exists to prevent.
    expect(raw).not.toContain('ZENDESK_DATA_DIR');
  });

  it('still launches the bundled plugin server from the plugin root', () => {
    // ${CLAUDE_PLUGIN_ROOT} stays: it is substituted by the host, not by user configuration. The
    // entry point is the esbuild BUNDLE, which is a different file from the MCPB manifest's tsc
    // output (manifest.json → dist/server.js) on purpose.
    expect(plugin.mcpServers.zendesk.command).toBe('node');
    expect(plugin.mcpServers.zendesk.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/plugin/server.js']);
  });

  // Relocated from tests/plugin/mcpb-manifest.test.ts:173-177 when the MCPB path was retired (#103).
  // The claim is about what SHIPS, and after the retirement this file is the only shipped manifest
  // left to make it about: a hard-coded view, group, form, field or brand id would tie the published
  // plugin to one Zendesk instance, and every customer registers their own. Asserted on the raw text
  // so an id smuggled in under a key nothing here reads still fails.
  it('ships no Zendesk instance data: no ids, no view/group/form/field pre-configuration', () => {
    expect(raw).not.toMatch(/"\w*_id"\s*:\s*\d/);
    expect(raw).not.toMatch(/\b(view_id|group_id|ticket_form_id|custom_field_id|brand_id)\b/);
  });
});
