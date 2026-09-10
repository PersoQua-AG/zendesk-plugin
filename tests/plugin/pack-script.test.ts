import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// The bundle's runtime dependency set is frozen: everything here is shipped inside the .mcpb, so a
// new entry is a supply-chain decision, not a detail. The MCPB CLI must stay out of it (npx only).
const FROZEN_DEPENDENCIES = ['@modelcontextprotocol/sdk', 'express', 'express-rate-limit', 'zod'];

describe('mcpb pack script', () => {
  // Static on purpose: a real `mcpb pack` needs the network (npx) and is a manual release step.
  it('packs the bundle with the MCPB CLI fetched through npx, into zendesk.mcpb', () => {
    const script: string = pkg.scripts.pack;
    expect(script).toMatch(/^npx\b/);
    expect(script).toContain('@anthropic-ai/mcpb');
    expect(script).toMatch(/\bpack\b/);
    expect(script).toContain('zendesk.mcpb');
  });

  it('adds no runtime dependency for packaging', () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual([...FROZEN_DEPENDENCIES].sort());
    expect(pkg.dependencies['@anthropic-ai/mcpb']).toBeUndefined();
    expect(pkg.devDependencies['@anthropic-ai/mcpb']).toBeUndefined();
  });

  it('keeps the built bundle out of git', () => {
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^\*\.mcpb$/m);
  });
});

describe('manifest release gate', () => {
  it('passes for all three shipped manifests', () => {
    const out = execFileSync('node', [join(root, 'scripts', 'validate-manifests.mjs')], { encoding: 'utf8' });
    expect(out).toContain('manifest.json');
  });

  it('checks manifest.json for the MCPB-required fields', () => {
    const script = readFileSync(join(root, 'scripts', 'validate-manifests.mjs'), 'utf8');
    for (const field of ['manifest_version', 'name', 'version', 'description', 'author', 'server']) {
      expect(script, field).toContain(`'${field}'`);
    }
  });
});
