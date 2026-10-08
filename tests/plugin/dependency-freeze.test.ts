// tests/plugin/dependency-freeze.test.ts
// The only guard in this repo against a runtime dependency that arrives unannounced. It lived in
// tests/plugin/pack-script.test.ts while the `.mcpb` bundle was the shipping vehicle; the MCPB path
// is retired (#103) and the assertion has no MCPB content, so it moves here rather than dying with
// that file.
//
// The reason it still holds, by the new route: `npm run build` bundles the server with esbuild
// (package.json:12, `--bundle`), so every entry below is COMPILED INTO dist/plugin/server.js and
// shipped with the plugin. A new entry is therefore still a supply-chain decision rather than a
// detail — the same decision, reached over a different path.
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
    // Kept after the retirement on purpose: nothing here may pull the MCPB CLI back in, on either
    // side of the manifest. There is no packaging step left that would need it.
    expect(pkg.dependencies['@anthropic-ai/mcpb']).toBeUndefined();
    expect(pkg.devDependencies['@anthropic-ai/mcpb']).toBeUndefined();
  });
});
