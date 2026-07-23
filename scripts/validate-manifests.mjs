// scripts/validate-manifests.mjs
// CI release-gate manifest check. The `claude` CLI (which would run `claude plugin validate
// --strict`) is NOT available on stock GitHub Actions runners, so a validate step would always
// fail. This is the fallback the CI task specifies: assert both plugin manifests parse as JSON
// and carry their required fields. Zero deps — plain Node — so it runs before/without npm ci.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// [file, [required top-level keys]]. Values must be present and non-empty (non-empty string,
// non-empty array, or a non-null object) — an empty/blank required field fails the gate.
const CHECKS = [
  ['.claude-plugin/plugin.json', ['name', 'version', 'mcpServers']],
  ['.claude-plugin/marketplace.json', ['name', 'owner', 'plugins']],
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

if (errors.length > 0) {
  console.error('Manifest validation failed:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('Manifest validation passed: plugin.json + marketplace.json parse and carry required fields.');
