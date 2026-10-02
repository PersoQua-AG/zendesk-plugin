// src/tools/diagnostics.ts
// What the plugin can tell about the host it was loaded into. It exists because Claude Desktop loads
// no local plugin — it serves them from the account marketplace, which pulls `main` — so the only
// way to measure the host is to ship the measurement. Deliberately FACTS ABOUT shapes, never values:
// an env var is reported as substituted/literal-placeholder/unset and never printed, so the report is
// safe to paste into an issue.
import { hostname, release } from 'node:os';
import { createServer } from 'node:http';
import { isPlaceholder } from '../auth/config.js';

const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'] as const;

export type SubstitutionState = 'substituted' | 'literal-placeholder' | 'unset';

// The three states a ${...} env entry can reach the server in. "literal-placeholder" is the one that
// matters: a host that does not substitute passes the placeholder through as text, and every
// downstream default then has to treat it as absent (src/auth/config.ts stripPlaceholders).
export function substitutionState(raw: string | undefined): SubstitutionState {
  if (!raw) return 'unset';
  return isPlaceholder(raw) ? 'literal-placeholder' : 'substituted';
}

// Whether the callback port is bindable per family RIGHT NOW. Binds and closes immediately: this is
// the same question the login flow asks, asked before the user is sent to Zendesk.
function probeBind(port: number, address: string): Promise<string> {
  return new Promise<string>((done) => {
    const server = createServer();
    // The code, not the message: a listen error always carries one, and the message repeats the
    // address — which is already in the line.
    server.on('error', (err) => done(`${address}:${port} unavailable (${(err as NodeJS.ErrnoException).code})`));
    server.listen(port, address, () => server.close(() => done(`${address}:${port} binds`)));
  });
}

export interface DiagnosticsInput {
  rawEnv: NodeJS.ProcessEnv;
  callbackPort: number;
  // Exactly what the client announced in `initialize`, rendered verbatim: this is what reveals
  // whether elicitation exists on this host and in which modes, and a summary would lose that.
  clientCapabilities: unknown;
}

export async function diagnosticsReport(input: DiagnosticsInput): Promise<string> {
  const binds = await Promise.all(LOOPBACK_ADDRESSES.map((address) => probeBind(input.callbackPort, address)));
  return [
    `hostname: ${hostname()}`,
    `platform: ${process.platform}`,
    `os release: ${release()}`,
    `node: ${process.version}`,
    `CLAUDE_PLUGIN_ROOT: ${substitutionState(input.rawEnv.CLAUDE_PLUGIN_ROOT)}`,
    `CLAUDE_PLUGIN_DATA (host-set, not read by this server): ${substitutionState(input.rawEnv.CLAUDE_PLUGIN_DATA)}`,
    'client capabilities from initialize (verbatim):',
    JSON.stringify(input.clientCapabilities ?? null, null, 2),
    'callback port:',
    ...binds.map((line) => `  ${line}`),
  ].join('\n');
}
