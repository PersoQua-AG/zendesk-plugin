// scripts/validate-manifests.mjs
// CI release-gate manifest check. The `claude` CLI (which would run `claude plugin validate
// --strict`) is NOT available on stock GitHub Actions runners, so a validate step would always
// fail. This is the fallback the CI task specifies: assert both plugin manifests parse as JSON
// and carry their required fields. Zero deps — plain Node — so it runs before/without npm ci.
//
// It also owns the VERSION fan-out, and since the MCPB path was retired (#103) it owns it alone:
// the second gate that used to see part of it (scripts/audit-bundle.mjs, taken from the packed
// bundle) is gone with that path. The project declares its version in seven hand-kept places, all
// checked below against package.json. Checking them here rather than in a test puts one owner on
// the question and makes the eventual fix (derive the version from package.json instead of keeping
// it seven times) a single-file change. This script is CI's FIRST step, so a disagreement fails
// before anything is built.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// [file, [required top-level keys]]. Values must be present and non-empty (non-empty string,
// non-empty array, or a non-null object) — an empty/blank required field fails the gate.
const CHECKS = [
  // manifest.json used to lead this list with the MCPB-required fields. The MCPB path is retired
  // (#103) and the file is gone, so the two Claude Code manifests are the whole shipped set.
  ['.claude-plugin/plugin.json', ['name', 'version', 'mcpServers']],
  ['.claude-plugin/marketplace.json', ['name', 'owner', 'plugins']],
];

// [label, reader]. Every live declaration of the project version; the value each one yields must
// equal package.json's. The reference used to be manifest.json's number, and #68 split the two —
// with the MCPB path retired (#103) there is only the one family left, and package.json names it.
//
// dist/server.js is here and src/server.ts is too, and the list keeps BOTH: dist/ is committed on
// purpose so a marketplace install runs without a build step (README, "`dist/` is committed on
// purpose"), so dist/ is the copy a host actually runs. Pinning the source alone would stay green
// while a build-less commit shipped the old number. A grep of the tree for the previous version
// found no further site; fixtures in tests/ and frozen plans in docs/ are not declarations.
const VERSION_SITES = [
  ['package-lock.json', (t) => JSON.parse(t).version],
  ['package-lock.json (packages."")', (t) => JSON.parse(t).packages['']?.version],
  ['.claude-plugin/plugin.json', (t) => JSON.parse(t).version],
  ['.claude-plugin/marketplace.json', (t) => JSON.parse(t).metadata?.version],
  ['src/server.ts', (t) => t.match(/new McpServer\(\{ name: 'zendesk', version: '([^']+)' \}\)/)?.[1]],
  ['dist/server.js', (t) => t.match(/new McpServer\(\{ name: 'zendesk', version: '([^']+)' \}\)/)?.[1]],
];

function isEmpty(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

const errors = [];
for (const [rel, requiredKeys] of CHECKS) {
  const path = join(root, rel);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    errors.push(`${rel}: not valid JSON — ${err.message}`);
    continue;
  }
  for (const key of requiredKeys) {
    if (isEmpty(parsed[key])) errors.push(`${rel}: missing or empty required field "${key}"`);
  }
}

// marketplace.plugins must be a non-empty array of {name, source} entries — this is what the
// marketplace loader dereferences, so an entry missing either field is a broken release.
try {
  const mkt = JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  if (Array.isArray(mkt.plugins)) {
    mkt.plugins.forEach((p, i) => {
      if (isEmpty(p?.name)) errors.push(`marketplace.json: plugins[${i}] missing "name"`);
      if (isEmpty(p?.source)) errors.push(`marketplace.json: plugins[${i}] missing "source"`);
    });
  }
} catch {
  // JSON-parse failure is already reported by the loop above.
}

// The version fan-out, against package.json as the reference.
let reference = null;
try {
  reference = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
} catch {
  // Already reported above.
}
if (reference) {
  for (const [label, read] of VERSION_SITES) {
    const file = label.split(' ')[0];
    let found;
    try {
      found = read(readFileSync(join(root, file), 'utf8'));
    } catch (err) {
      errors.push(`${label}: could not be read for its version — ${err.message}`);
      continue;
    }
    // undefined means the shape moved, not that the versions agree. marketplace.json keeps its
    // version under `metadata`, which is exactly the kind of assumption that goes stale.
    if (found === undefined || found === null) {
      errors.push(`${label}: declares no version where one is expected — has the file's shape changed?`);
    } else if (found !== reference) {
      errors.push(`${label}: declares ${found}, package.json declares ${reference}`);
    }
  }
}

if (errors.length > 0) {
  console.error('Manifest validation failed:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('Manifest validation passed: plugin.json + marketplace.json parse and carry required fields.');
console.log(`Version agreement: package.json and all ${VERSION_SITES.length} other declarations say ${reference}.`);
