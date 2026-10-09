// tests/plugin/dependency-freeze.test.ts
// The only guard in this repo against a runtime dependency that arrives unannounced.
//
// Why it bites: `npm run build` bundles the server with esbuild (`--bundle`), so every entry below
// is compiled INTO dist/plugin/server.js and ships with the plugin. A new entry is a supply-chain
// decision, not a detail.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const FROZEN_DEPENDENCIES = ['@modelcontextprotocol/sdk', 'express', 'express-rate-limit', 'parse5', 'zod'];

describe('the shipped runtime dependency set', () => {
  it('is frozen, and pulls in the MCPB CLI on neither side', () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual([...FROZEN_DEPENDENCIES].sort());
    // Only the devDependencies half is asserted separately. A `dependencies` entry for the CLI is
    // already caught by the set equality above — it could never have gone red on its own — while
    // devDependencies are not compared anywhere, so this is the one line with its own reach. Kept
    // after the retirement on purpose: no packaging step is left that would need the CLI.
    expect(pkg.devDependencies['@anthropic-ai/mcpb']).toBeUndefined();
  });
});
