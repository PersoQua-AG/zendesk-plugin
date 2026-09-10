import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// The bundle's runtime dependency set is frozen: everything here is shipped inside the .mcpb, so a
// new entry is a supply-chain decision, not a detail. The MCPB CLI must stay out of it (npx only).
const FROZEN_DEPENDENCIES = ['@modelcontextprotocol/sdk', 'express', 'express-rate-limit', 'zod'];

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe('mcpb pack script', () => {
  // Static on purpose: a real `mcpb pack` needs the network (npx) and is a manual release step.
  it('packs the bundle with the MCPB CLI fetched through npx, into zendesk.mcpb', () => {
    const script: string = pkg.scripts.pack;
    expect(script).toContain('npx');
    expect(script).toContain('@anthropic-ai/mcpb');
    expect(script).toMatch(/\bpack\b/);
    expect(script).toContain('zendesk.mcpb');
  });

  it('refuses to reach the packer before the production-tree gate has passed', () => {
    expect(pkg.scripts.pack as string).toMatch(/^node scripts\/assert-prod-tree\.mjs &&/);
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

// ---------------------------------------------------------------------------------------------
// What actually ends up inside the bundle.
//
// `mcpb pack` does NOT read .gitignore. It builds its ignore list from EXCLUDE_PATTERNS plus the
// lines of .mcpbignore and nothing else (@anthropic-ai/mcpb@2.1.2 dist/node/files.js:5-38, :44-62,
// :69-88). An entry that exists only in .gitignore therefore ships. These tests ask the ignore
// question the packer asks, against real paths — not whether a string appears in a file.
// ---------------------------------------------------------------------------------------------

// Verbatim from @anthropic-ai/mcpb@2.1.2 dist/node/files.js:5-38.
const EXCLUDE_PATTERNS = [
  '.DS_Store', 'Thumbs.db', '.gitignore', '.git', '.mcpbignore', '*.log', '.env*', '.npm', '.npmrc',
  '.yarnrc', '.yarn', '.eslintrc', '.editorconfig', '.prettierrc', '.prettierignore', '.eslintignore',
  '.nycrc', '.babelrc', '.pnp.*', 'node_modules/.cache', 'node_modules/.bin', '*.map', '.env.local',
  '.env.*.local', 'npm-debug.log*', 'yarn-debug.log*', 'yarn-error.log*', 'package-lock.json',
  'yarn.lock', '*.mcpb', '*.d.ts', '*.tsbuildinfo', 'tsconfig.json',
];

// Same parse as readMcpbIgnorePatterns (files.js:44-59): trim, drop blanks and comments.
function ignoreLines(file: string): string[] {
  return readFileSync(join(root, file), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

// Stand-in for ignore().add(patterns).ignores(path) (files.js:60-62), covering the three gitignore
// pattern shapes both lists actually use: a directory ("src/"), a bare name ("tokens.enc") and a
// glob ("*.log"). An unanchored pattern matches at ANY depth; one containing "/" is anchored.
function excludes(patterns: string[], path: string): boolean {
  const segments = path.split('/');
  return patterns.some((pattern) => {
    const dirOnly = pattern.endsWith('/');
    const body = dirOnly ? pattern.slice(0, -1) : pattern;
    if (body.includes('/')) return path === body || path.startsWith(`${body}/`);
    const re = new RegExp(`^${body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    return segments.some((seg, i) => re.test(seg) && (!dirOnly || i < segments.length - 1));
  });
}

const PACKER_PATTERNS = [...EXCLUDE_PATTERNS, ...ignoreLines('.mcpbignore')];

describe('what mcpb pack puts in the bundle', () => {
  it.each([
    '.zendesk-plugin-data/tokens.enc',
    '.zendesk-plugin-data/audit/write-audit.jsonl',
    '.zendesk-plugin-data/cache/zendesk_get_me-a1b2c3.json',
    'tokens.enc',
    'memory/index.md',
  ])('never ships credentials or runtime state: %s', (path) => {
    expect(excludes(PACKER_PATTERNS, path)).toBe(true);
  });

  it('owes that protection to .mcpbignore, not to .gitignore or the packer defaults', () => {
    // The exact shape of the leak this guards: .gitignore covers the data dir, and the packer never
    // reads it; the packer's own EXCLUDE_PATTERNS do not cover it either. Only .mcpbignore does.
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.zendesk-plugin-data');
    expect(excludes(EXCLUDE_PATTERNS, '.zendesk-plugin-data/tokens.enc')).toBe(false);
    expect(excludes(EXCLUDE_PATTERNS, 'tokens.enc')).toBe(false);
  });

  it.each([
    'src/server.ts',
    'tests/plugin/pack-script.test.ts',
    '.github/workflows/ci.yml',
    'scripts/assert-prod-tree.mjs',
    '.claude-plugin/plugin.json',
    'tsconfig.json',
    'coverage/lcov.info',
    'coverage/lcov-report/index.html',
  ])('leaves repo-only material out: %s', (path) => {
    expect(excludes(PACKER_PATTERNS, path)).toBe(true);
  });

  it('keeps coverage output out for the same reason as the data dir: .mcpbignore, not .gitignore', () => {
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^coverage\/$/m);
    // The packer's own defaults do not cover it — `npm run test:coverage` before a pack would ship it.
    expect(excludes(EXCLUDE_PATTERNS, 'coverage/lcov.info')).toBe(false);
    expect(excludes(PACKER_PATTERNS, 'coverage/lcov.info')).toBe(true);
  });

  it.each(['manifest.json', 'package.json', 'dist/server.js', 'README.md', 'node_modules/zod/package.json'])(
    'still ships what the extension runs: %s',
    (path) => {
      expect(excludes(PACKER_PATTERNS, path)).toBe(false);
    },
  );

  it('cannot keep the dev toolchain out on its own — that is the prod-tree gate', () => {
    // Documented on purpose: node_modules ships wholesale, which is exactly why `pack` runs
    // scripts/assert-prod-tree.mjs first instead of trusting a README step.
    expect(excludes(PACKER_PATTERNS, 'node_modules/typescript/lib/tsc.js')).toBe(false);
    expect(excludes(PACKER_PATTERNS, 'node_modules/vitest/package.json')).toBe(false);
  });
});

describe('production-tree gate', () => {
  // Runs the real script against a throwaway tree — it resolves its root from its own location.
  function runGuardIn(tree: string): { status: number | null; stderr: string; stdout: string } {
    mkdirSync(join(tree, 'scripts'), { recursive: true });
    copyFileSync(join(root, 'scripts', 'assert-prod-tree.mjs'), join(tree, 'scripts', 'assert-prod-tree.mjs'));
    const r = spawnSync('node', [join(tree, 'scripts', 'assert-prod-tree.mjs')], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout };
  }

  function prodTree(): string {
    const tree = tempRoot('prod-tree-');
    mkdirSync(join(tree, 'dist'), { recursive: true });
    writeFileSync(join(tree, 'dist', 'server.js'), '');
    mkdirSync(join(tree, 'node_modules', 'zod'), { recursive: true });
    return tree;
  }

  it('passes on a built tree with only runtime dependencies installed', () => {
    const r = runGuardIn(prodTree());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/production tree confirmed/i);
  });

  it.each(['typescript', 'vitest', '@vitest/coverage-v8', '@types/node'])('fails when the dev dependency %s is still installed', (dev) => {
    const tree = prodTree();
    mkdirSync(join(tree, 'node_modules', dev), { recursive: true });
    const r = runGuardIn(tree);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(dev);
    expect(r.stderr).toMatch(/npm ci --omit=dev/);
  });

  it('fails when dist/server.js was never built', () => {
    const tree = tempRoot('prod-tree-');
    mkdirSync(join(tree, 'node_modules', 'zod'), { recursive: true });
    const r = runGuardIn(tree);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/dist\/server\.js is missing/);
  });
});

describe('manifest release gate', () => {
  it('passes for all three shipped manifests', () => {
    const out = execFileSync('node', [join(root, 'scripts', 'validate-manifests.mjs')], { encoding: 'utf8' });
    expect(out).toContain('manifest.json');
  });

  // Behaviour, not grep: hand the real script a broken manifest and require a non-zero exit.
  function runValidatorOn(manifest: Record<string, unknown>): { status: number | null; stderr: string } {
    const tree = tempRoot('manifest-gate-');
    mkdirSync(join(tree, 'scripts'), { recursive: true });
    mkdirSync(join(tree, '.claude-plugin'), { recursive: true });
    copyFileSync(join(root, 'scripts', 'validate-manifests.mjs'), join(tree, 'scripts', 'validate-manifests.mjs'));
    writeFileSync(join(tree, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(
      join(tree, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'zendesk', version: '0.1.0', mcpServers: { zendesk: {} } }),
    );
    writeFileSync(
      join(tree, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'zendesk', owner: { name: 'PersoQua' }, plugins: [{ name: 'zendesk', source: './' }] }),
    );
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
});
