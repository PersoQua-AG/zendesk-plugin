// scripts/assert-prod-tree.mjs
// Release gate for `npm run pack`. `mcpb pack` ships whatever is in node_modules — .mcpbignore
// excludes sources and tests, but not dependencies, and the bundle is unsigned. A release that
// forgets `npm ci --omit=dev` therefore ships the whole build/test toolchain (measured: 17.2 MB
// instead of 2.6 MB, including typescript and vitest) as attack surface. This turns "remember the
// README step" into a hard failure. Zero deps — plain Node, and it is excluded from the bundle.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

// The dev-only markers ARE the repo's own devDependencies — read, not restated. A hand-kept copy
// (there was one here and a second one in the test) silently stops matching the day a tool is added
// or dropped, and this gate would then wave through exactly what it exists to catch. None of the
// four frozen runtime dependencies depends on any of them.
let devMarkers = [];
try {
  devMarkers = Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies ?? {});
} catch {
  problems.push('package.json is missing or unreadable — this is not a packable tree');
}
for (const name of devMarkers) {
  if (existsSync(join(root, 'node_modules', name))) problems.push(`node_modules/${name} is present (devDependency)`);
}

// A bundle without the compiled entry point is dead on arrival at the host.
if (!existsSync(join(root, 'dist', 'server.js'))) problems.push('dist/server.js is missing — run `npm run build` first');

if (problems.length > 0) {
  console.error('Refusing to pack: this is not a production tree.');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nProduce one with:\n  npm run build\n  npm ci --omit=dev --ignore-scripts\n  npm run pack\n  npm ci   # restore the dev toolchain');
  process.exit(1);
}
console.log('Production tree confirmed: dist/server.js present, no dev dependencies in node_modules.');
