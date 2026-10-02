// src/register/diagnostics.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toText } from '../tools/result.js';
import { diagnosticsReport } from '../tools/diagnostics.js';

// Registered unconditionally, including while the configuration is incomplete: a host that cannot
// configure the plugin is exactly the host this tool is there to describe.
export function registerDiagnosticsTool(
  server: McpServer,
  deps: { rawEnv: NodeJS.ProcessEnv; callbackPort: number },
): void {
  server.registerTool(
    'zendesk_diagnostics',
    {
      description:
        'Report how this host loaded the plugin: hostname, platform, OS release, whether CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA were substituted by the host (never their values; the server reads neither for its data directory), the client capabilities announced in initialize, and whether the OAuth callback port binds per address family. Carries no configuration value and no credential.',
    },
    async () =>
      toText(
        await diagnosticsReport({
          ...deps,
          // Read at CALL time, not at registration: the client announces its capabilities during
          // initialize, which happens after every tool is registered.
          clientCapabilities: server.server.getClientCapabilities(),
        }),
      ),
  );
}
