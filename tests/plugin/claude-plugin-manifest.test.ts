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
// So the second negative property: the env block may declare no name the host reserves for itself.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const raw = readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8');
const plugin = JSON.parse(raw);
const env: Record<string, string> = plugin.mcpServers.zendesk.env ?? {};

// The host refuses an env name it sets itself. These are the reserved PREFIXES, not the whole list:
// the predicate also holds an exact-name list of ~90 entries (NODE_OPTIONS, HOME, TMPDIR, APPDATA, the
// GO*/PERL*/PYTHON* families, …) that is too version-specific to copy here, so this guard is a FLOOR —
// a reserved name outside these prefixes would still pass it.
//
// Re-derive rather than trust: read Claude Desktop 2.19675.0's
// /Applications/Claude.app/Contents/Resources/app.asar and find the string
// "reserved variable name"; the predicate called just before that throw holds both lists, and the only
// two exemptions are PATH and CLAUDE_PLUGIN_ROOT. Claude Code 2.1.287 carries the same families.
const RESERVED_PREFIXES = /^(CLAUDE_|ANTHROPIC_|OTEL_|LD_|DYLD_|BASH_FUNC_|GIT_|NPM_CONFIG_|UV_)/;

describe('the Claude Code plugin manifest', () => {
  it('references no plugin user configuration at all — the one line that dropped the server', () => {
    expect(raw).not.toContain('${user_config.');
    expect(plugin.userConfig).toBeUndefined();
  });

  it('declares no env name the host reserves — the one line that dropped the server after #68', () => {
    // CLAUDE_PLUGIN_DATA in particular: the host injects it into every plugin stdio server itself,
    // so declaring it was never a passthrough, only a rejection. Same rationale as the MCPB side
    // (tests/plugin/mcpb-manifest.test.ts).
    expect(raw).not.toContain('CLAUDE_PLUGIN_DATA');
    const reserved = Object.keys(env).filter(
      (name) => name.toUpperCase() !== 'CLAUDE_PLUGIN_ROOT' && RESERVED_PREFIXES.test(name.toUpperCase()),
    );
    expect(reserved).toEqual([]);
  });

  it('still launches the bundled plugin server from the plugin root', () => {
    // ${CLAUDE_PLUGIN_ROOT} stays: it is substituted by the host, not by user configuration. The
    // entry point is the esbuild BUNDLE, which is a different file from the MCPB manifest's tsc
    // output (manifest.json → dist/server.js) on purpose.
    expect(plugin.mcpServers.zendesk.command).toBe('node');
    expect(plugin.mcpServers.zendesk.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/plugin/server.js']);
  });
});
