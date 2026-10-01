// scripts/assert-no-bound-port-literals.mjs
// A fixed port on a bind call collides with a concurrent `vitest run` (#23); use freePort().
//
// THE CALLER NAMES THE TREE (#73). The scan root is argv[2] and there is no default. Measured on
// PR #72, mutation M3: while the guard chose its own directory, bending that choice to another
// directory still reported success — "scanned the wrong tree" and "found nothing" produced the
// same green. Here there is no directory constant to bend: the tree comes from package.json and
// from CI, and a root with no .ts file in it is refused instead of reported clean.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';

// This reads source text, so it is evadable by construction. Blind spots, all deliberate:
//   - only the call names listed below are matched;
//   - only a decimal literal written at the call site — a const, a variable, 18e3, 0x4650 or a
//     computed port is not traced, and a call on `70_000 - 52_000` stays green because the
//     first literal is filtered as out of range;
//   - an expression is reported by its first literal, so a call on `17_000 + 1_000` is flagged
//     as 17_000. The file and line are right, the number is not. Requiring the literal to be
//     followed by , or ) would trade that loud wrong number for silence here, and for new
//     misses on a cast such as `18000 as Port`, so the call site keeps winning over the number;
//   - a mention in a comment or a string counts. That no longer forces anyone to write a sample
//     split as `'deps' + '(18000)'`: the guard's own test lives in tests/plugin and its samples
//     live in temp directories, both outside any tree this guard is pointed at;
//   - only files directly in the given root are scanned, not its subfolders.
// Catching the rest needs a parser or a runtime check, not a wider regex (out of scope, #74).
const BIND_CALL = /\b(waitForAuthorizationCode|startCallbackListener|listenOn|listen|rebind|config|deps)\(\s*(\d[\d_]*)\b/g;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (!process.argv[2]) {
  console.error('Expected a scan root: node scripts/assert-no-bound-port-literals.mjs <dir>');
  console.error('There is no default on purpose (#73): a guard that picks its own tree cannot');
  console.error('tell a clean tree from the wrong one — both come out green.');
  process.exit(1);
}
// Resolved against the repo root, so a relative argument is convenient and an absolute one (the
// tests hand it temp trees) is honoured rather than silently appended to the root.
const target = resolvePath(root, process.argv[2]);

// 0 is chosen by the OS and anything above 65535 is refused by listen() — neither binds a fixed port.
function isBindablePort(literal) {
  const port = Number(literal.replaceAll('_', ''));
  return port >= 1 && port <= 65_535;
}

// Findings are named relative to the repo root, which is what `tests/auth/login-harness.ts:12` in
// a CI log has to be to be clickable. A temp fixture outside the repo keeps its absolute path.
const show = (file) => (file.startsWith(root + sep) ? relative(root, file) : file);

let entries;
try {
  entries = readdirSync(target);
} catch (err) {
  console.error(`Cannot scan ${target}: ${err.code ?? err.message}.`);
  process.exit(1);
}

const files = entries.filter((f) => f.endsWith('.ts')).sort();
// An existing directory with nothing to scan is the M3 symptom, so it is an error, not a pass.
// The cut is "no .ts file here": it catches an empty, a missing-after-move or a non-source root.
// It does not catch a root that holds unrelated .ts files — pointing at one is a visible edit to
// package.json or to ci.yml, and the line below prints the root and the count in every run.
if (files.length === 0) {
  console.error(`No .ts file directly in ${target}.`);
  console.error('That is not a test tree, so a clean result here would mean nothing. Name the tree');
  console.error('to scan, for example tests/auth.');
  process.exit(1);
}

const findings = files.flatMap((file) => {
  const path = join(target, file);
  const source = readFileSync(path, 'utf8');
  return [...source.matchAll(BIND_CALL)]
    .filter(([, , literal]) => isBindablePort(literal))
    .map((m) => `${show(path)}:${source.slice(0, m.index).split('\n').length} ${m[1]}(${m[2]})`);
});

// Printed in every outcome, pass or fail: a green line that names the tree and the count is the
// only way a reader can tell "clean" from "looked at almost nothing".
console.log(`Bound port literals in ${show(target)}/: ${files.length} files scanned.`);

if (findings.length > 0) {
  console.error('\nRefusing the tree: a bind call names a fixed port.');
  for (const finding of findings) console.error(`  - ${finding}`);
  console.error(
    '\nA fixed port collides with a concurrent `vitest run` (#23). Acquire one instead:' +
      '\n  const port = await freePort();\n',
  );
  process.exit(1);
}

console.log('Every bound port is acquired, none is written as a literal.');
