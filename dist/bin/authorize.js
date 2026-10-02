#!/usr/bin/env node
import { resolve } from 'node:path';
import { resolveAuthConfig } from '../auth/config.js';
import { authorize } from '../auth/authorize.js';
async function main() {
    const { config, tokensPath, tokenStoreKey } = resolveAuthConfig(process.env);
    const absoluteTokensPath = resolve(tokensPath);
    process.stdout.write(`Tokens will be written to: ${absoluteTokensPath}\n`);
    await authorize({ config, tokensPath, tokenStoreKey });
}
main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Authorization failed: ${message}\n`);
    process.exitCode = 1;
});
