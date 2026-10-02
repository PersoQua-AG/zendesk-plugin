#!/usr/bin/env node
import { resolve } from 'node:path';
import { resolveAuthConfig } from '../auth/config.js';
import { authorize } from '../auth/authorize.js';
async function main() {
    const { config, tokensPath, tokenStoreKey } = resolveAuthConfig(process.env);
    const absoluteTokensPath = resolve(tokensPath);
    // Both this bin and the server resolve the directory the same way and neither manifest passes one, so
    // run by hand with nothing exported they agree and no warning is owed. The one way to make them
    // disagree is to export ZENDESK_DATA_DIR for only one of the two, so say so when it IS set.
    if (process.env.ZENDESK_DATA_DIR) {
        process.stdout.write('NOTE: ZENDESK_DATA_DIR is set, so this bin is NOT writing to the default directory. Export the ' +
            'same value for the server, or it will report "No authorization found".\n');
    }
    process.stdout.write(`Tokens will be written to: ${absoluteTokensPath}\n`);
    await authorize({ config, tokensPath, tokenStoreKey });
}
main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Authorization failed: ${message}\n`);
    process.exitCode = 1;
});
