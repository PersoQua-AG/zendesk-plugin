// tests/plugin/manifest-release-gate.test.ts
// The only behaviour test of scripts/validate-manifests.mjs, the gate CI runs first. What that
// script owns and why is in its own header; one owner for that question is enough.
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

describe('manifest release gate', () => {
  it('passes for both shipped manifests', () => {
    const out = execFileSync('node', [join(root, 'scripts', 'validate-manifests.mjs')], { encoding: 'utf8' });
    expect(out).toContain('plugin.json');
    expect(out).toContain('marketplace.json');
  });

  // The fixture carries EVERY file the validator reads, because it owns the version fan-out and a
  // missing file there is an error rather than a skip. `shape` lets a caller break one manifest's
  // shape (delete or blank a required field); `overrides` lets a caller put one version site out of
  // step to prove the fan-out bites.
  type Shape = {
    plugin?: (o: Record<string, unknown>) => void;
    marketplace?: (o: Record<string, unknown>) => void;
  };

  const VERSION = '0.1.0';

  function runValidatorOn(shape: Shape = {}, overrides: Record<string, string | null> = {}): {
    status: number | null;
    stderr: string;
  } {
    const tree = mkdtempSync(join(tmpdir(), 'manifest-gate-'));
    temps.push(tree);
    mkdirSync(join(tree, 'scripts'), { recursive: true });
    mkdirSync(join(tree, '.claude-plugin'), { recursive: true });
    mkdirSync(join(tree, 'src'), { recursive: true });
    mkdirSync(join(tree, 'dist'), { recursive: true });
    copyFileSync(join(root, 'scripts', 'validate-manifests.mjs'), join(tree, 'scripts', 'validate-manifests.mjs'));
    // `null` for a site means "omit the declaration entirely" — a moved shape, not a disagreement.
    const v = (site: string): string | undefined =>
      site in overrides ? (overrides[site] ?? undefined) : VERSION;
    const server = (site: string): string =>
      v(site) === undefined
        ? 'const server = new McpServer({ name: "zendesk" });\n'
        : `const server = new McpServer({ name: 'zendesk', version: '${v(site)}' });\n`;

    const plugin: Record<string, unknown> = {
      name: 'zendesk',
      version: v('.claude-plugin/plugin.json'),
      mcpServers: { zendesk: {} },
    };
    const mktVersion = v('.claude-plugin/marketplace.json');
    const marketplace: Record<string, unknown> = {
      name: 'zendesk',
      owner: { name: 'PersoQua' },
      // Under `metadata`, which is where the validator reads it and where it is easy to miss.
      metadata: mktVersion === undefined ? {} : { version: mktVersion },
      plugins: [{ name: 'zendesk', source: './' }],
    };
    shape.plugin?.(plugin);
    shape.marketplace?.(marketplace);

    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'zendesk-plugin', version: v('package.json') }),
      'package-lock.json': JSON.stringify({
        name: 'zendesk-plugin',
        version: v('package-lock.json'),
        packages: { '': { version: v('package-lock.json (packages."")') } },
      }),
      '.claude-plugin/plugin.json': JSON.stringify(plugin),
      '.claude-plugin/marketplace.json': JSON.stringify(marketplace),
      'src/server.ts': server('src/server.ts'),
      'dist/server.js': server('dist/server.js'),
    };
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(tree, rel), body);
    const r = spawnSync('node', [join(tree, 'scripts', 'validate-manifests.mjs')], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr };
  }

  it('accepts a tree whose manifests carry every required field and agree on the version', () => {
    expect(runValidatorOn().status).toBe(0);
  });

  const REL = {
    plugin: '.claude-plugin/plugin.json',
    marketplace: '.claude-plugin/marketplace.json',
  } as const;

  // The required-field matrix, driven off the two surviving CHECKS entries rather than off
  // manifest.json's MCPB fields.
  //
  // Asserted on the EXACT message, never on the bare field name. `toContain(field)` passed for
  // `version` without the required-field rule saying anything: deleting it also trips the
  // VERSION_SITES loop, whose "declares no version where one is expected" carries the substring
  // `version` and satisfied the assertion by proxy — the case stayed green under a mutant that
  // disabled the rule it claims to pin. `name` and `plugins` are latent carriers of the same kind
  // (the `plugins[0] missing "name"/"source"` messages). A substring assertion is only as strong as
  // the set of texts that can carry that substring.
  it.each([
    ['plugin', 'name'],
    ['plugin', 'version'],
    ['plugin', 'mcpServers'],
    ['marketplace', 'name'],
    ['marketplace', 'owner'],
    ['marketplace', 'plugins'],
  ] as const)('rejects %s.json missing %s', (which, field) => {
    const r = runValidatorOn({ [which]: (o: Record<string, unknown>) => delete o[field] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${REL[which]}: missing or empty required field "${field}"`);
  });

  it('rejects a manifest whose required field is present but blank', () => {
    const r = runValidatorOn({ plugin: (o) => (o.name = '   ') });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${REL.plugin}: missing or empty required field "name"`);
  });

  // The version fan-out: seven hand-kept declarations, package.json the reference and six sites
  // measured against it. Putting any ONE of them out of step must fail the gate.
  it.each([
    'package.json',
    'package-lock.json',
    'package-lock.json (packages."")',
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    'src/server.ts',
    'dist/server.js',
  ])('rejects a tree where %s disagrees with the others', (site) => {
    const r = runValidatorOn({}, { [site]: '9.9.9' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${site.split(' ')[0]}`);
    expect(r.stderr).toContain('9.9.9');
  });

  it.each(['.claude-plugin/marketplace.json', 'src/server.ts', 'dist/server.js'])(
    'rejects %s when its version declaration is GONE, rather than reading undefined as agreement',
    (site) => {
      // marketplace.json keeps its version under `metadata`; assuming `plugins[0].version` is how
      // the site was missed in the first place. An absent value must fail, not silently pass.
      const moved = runValidatorOn({}, { [site]: null });
      expect(moved.status).not.toBe(0);
      expect(moved.stderr).toContain('declares no version where one is expected');
    },
  );
});
