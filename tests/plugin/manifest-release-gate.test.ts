// tests/plugin/manifest-release-gate.test.ts
// The only behaviour test of scripts/validate-manifests.mjs — the gate that CI runs FIRST
// (.github/workflows/ci.yml:100), before anything is installed or built. It lived in
// tests/plugin/pack-script.test.ts because `npm run pack` chained the validator; the MCPB path is
// retired (#103) and the validator is not, so the test moves here instead of dying with that file.
//
// Behaviour, not grep: every case runs the real script against a throwaway tree.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe('manifest release gate', () => {
  it('passes for all three shipped manifests', () => {
    const out = execFileSync('node', [join(root, 'scripts', 'validate-manifests.mjs')], { encoding: 'utf8' });
    expect(out).toContain('manifest.json');
  });

  // Behaviour, not grep: hand the real script a broken manifest and require a non-zero exit.
  // The fixture carries EVERY file the validator reads, because it also owns the version fan-out
  // now (see its header) and a missing file there is an error rather than a skip. `overrides` lets
  // a caller put one site out of step to prove the fan-out bites.
  function runValidatorOn(
    manifest: Record<string, unknown>,
    overrides: Record<string, string | null> = {},
  ): { status: number | null; stderr: string } {
    const tree = tempRoot('manifest-gate-');
    mkdirSync(join(tree, 'scripts'), { recursive: true });
    mkdirSync(join(tree, '.claude-plugin'), { recursive: true });
    mkdirSync(join(tree, 'src'), { recursive: true });
    mkdirSync(join(tree, 'dist'), { recursive: true });
    copyFileSync(join(root, 'scripts', 'validate-manifests.mjs'), join(tree, 'scripts', 'validate-manifests.mjs'));
    // `null` for a site means "omit the declaration entirely" — a moved shape, not a disagreement.
    const v = (site: string): string | undefined =>
      site in overrides ? (overrides[site] ?? undefined) : ((manifest.version as string) ?? '0.1.0');
    const server = (site: string): string =>
      v(site) === undefined
        ? 'const server = new McpServer({ name: "zendesk" });\n'
        : `const server = new McpServer({ name: 'zendesk', version: '${v(site)}' });\n`;
    const files: Record<string, string> = {
      'manifest.json': JSON.stringify(manifest),
      'package.json': JSON.stringify({ name: 'zendesk-plugin', version: v('package.json') }),
      'package-lock.json': JSON.stringify({
        name: 'zendesk-plugin',
        version: v('package-lock.json'),
        packages: { '': { version: v('package-lock.json (packages."")') } },
      }),
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'zendesk',
        version: v('.claude-plugin/plugin.json'),
        mcpServers: { zendesk: {} },
      }),
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'zendesk',
        owner: { name: 'PersoQua' },
        metadata: { ...(v('.claude-plugin/marketplace.json') === undefined ? {} : { version: v('.claude-plugin/marketplace.json') }) },
        plugins: [{ name: 'zendesk', source: './' }],
      }),
      'src/server.ts': server('src/server.ts'),
      'dist/server.js': server('dist/server.js'),
    };
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(tree, rel), body);
    const r = spawnSync('node', [join(tree, 'scripts', 'validate-manifests.mjs')], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr };
  }

  const validManifest = (): Record<string, unknown> => ({
    manifest_version: '0.3',
    name: 'zendesk',
    version: '0.1.0',
    description: 'd',
    author: { name: 'a' },
    server: { type: 'node' },
  });

  it('accepts a manifest that carries every MCPB-required field', () => {
    expect(runValidatorOn(validManifest()).status).toBe(0);
  });

  it.each(['manifest_version', 'name', 'version', 'description', 'author', 'server'])(
    'rejects a manifest missing %s',
    (field) => {
      const manifest = validManifest();
      delete manifest[field];
      const r = runValidatorOn(manifest);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(field);
    },
  );

  it('rejects a manifest whose required field is present but blank', () => {
    const r = runValidatorOn({ ...validManifest(), description: '   ' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('description');
  });

  // The version fan-out. Seven hand-kept declarations, and the gate that would otherwise catch a
  // disagreement (scripts/audit-bundle.mjs) can only see three of them.
  it.each([
    'package.json',
    'package-lock.json',
    'package-lock.json (packages."")',
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    'src/server.ts',
    'dist/server.js',
  ])('rejects a tree where %s disagrees with manifest.json', (site) => {
    const r = runValidatorOn(validManifest(), { [site]: '9.9.9' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${site.split(' ')[0]}`);
    expect(r.stderr).toContain('9.9.9');
  });

  it.each(['.claude-plugin/marketplace.json', 'src/server.ts', 'dist/server.js'])(
    'rejects %s when its version declaration is GONE, rather than reading undefined as agreement',
    (site) => {
      // marketplace.json keeps its version under `metadata`; assuming `plugins[0].version` is how
      // the site was missed in the first place. An absent value must fail, not silently pass.
      expect(runValidatorOn(validManifest()).status).toBe(0);
      const moved = runValidatorOn(validManifest(), { [site]: null });
      expect(moved.status).not.toBe(0);
      expect(moved.stderr).toContain('declares no version where one is expected');
    },
  );
});
