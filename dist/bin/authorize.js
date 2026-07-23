#!/usr/bin/env node
import { resolve } from 'node:path';
import { resolveAuthConfig } from '../auth/config.js';
import { authorize } from '../auth/authorize.js';
async function main() {
    const { config, dataDir, tokensPath } = resolveAuthConfig(process.env);
    const absoluteTokensPath = resolve(tokensPath);
    // The server reads CLAUDE_PLUGIN_DATA from plugin.json env; this bin is run by
    // hand. If it is unset here, the bin writes tokens.enc to a DIFFERENT dataDir
    // than the server reads → "No authorization found". Warn loudly so the user
    // exports the SAME value the server uses before authorizing.
    if (!process.env.CLAUDE_PLUGIN_DATA) {
        process.stdout.write('WARNING: CLAUDE_PLUGIN_DATA is not set. The plugin server reads it from its ' +
            'plugin.json env, so you MUST export the SAME CLAUDE_PLUGIN_DATA the server uses ' +
            'before authorizing, or the server will report "No authorization found".\n');
    }
    process.stdout.write(`Tokens will be written to: ${absoluteTokensPath}\n`);
    await authorize({ config, dataDir });
}
main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Authorization failed: ${message}\n`);
    process.exitCode = 1;
});
