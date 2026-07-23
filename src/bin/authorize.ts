#!/usr/bin/env node
import { resolveAuthConfig } from '../auth/config.js';
import { authorize } from '../auth/authorize.js';

async function main(): Promise<void> {
  const { config, dataDir } = resolveAuthConfig(process.env);
  await authorize({ config, dataDir });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Authorization failed: ${message}\n`);
  process.exitCode = 1;
});
