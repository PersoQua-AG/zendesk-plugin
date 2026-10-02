// scripts/assert-no-bound-port-literals.mjs
// A fixed port on a bind call collides with a concurrent `vitest run` (#23); use freePort().
//
// THE CALLER NAMES THE TREE (#73). The scan root is argv[2] and there is no default. Measured on
// PR #72, mutation M3: while the guard chose its own directory, bending that choice to another
// directory still reported success — "scanned the wrong tree" and "found nothing" produced the
// same green. Here there is no directory constant to bend, and a root that is not the guarded
// tree is refused instead of reported clean.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';

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
//     live in temp directories, neither of which is tests/auth. Point this script AT tests/plugin
//     and it does report the literals in that test file — correctly, they are written there;
//   - only files directly in the given root are scanned, not its subfolders.
// Catching the rest needs a parser or a runtime check, not a wider regex (out of scope, #74).
const BIND_CALL = /\b(waitForAuthorizationCode|startCallbackListener|listenOn|listen|rebind|config|deps)\(\s*(\d[\d_]*)\b/g;

// THE MARK OF THE GUARDED TREE: the tree that DEFINES the port allocator, not one that mentions it.
// "Holds .ts files" does not identify a tree: `tests` itself holds .ts files, so the most plausible
// misedit of all — naming the parent of the guarded directory — would scan those, miss all of
// tests/auth, and report success. A minimum file count cannot separate them either: tests/tools has
// more .ts files than tests/auth. What does separate them is the thing the guarded tree is guarded
// FOR — and the previous spelling of that, "some file here calls freePort()", did not survive one
// day. PR #71 (dc2ae3e) added 53 test files that call freePort(), among them one directly in
// `tests`, and three wrong roots (`tests`, `tests/tools`, plus the guarded tree) then exited 0.
// A mention travels with every caller; the definition does not. Recount both over every directory
// in this repo that holds a tracked .ts file with
//   git ls-files '*.ts' | xargs -n1 dirname | sort -u | while read d; do \
//     grep -lE '\bexport (async )?function freePort\(' "$d"/*.ts >/dev/null 2>&1 && echo "$d"; done
// Measured on this commit: 27 directories, of which **1** carries the definition (tests/auth, in
// login-harness.ts) and **4** merely mention freePort. The mark is the first number.
// The one cost, named rather than discovered later: this hangs on a name and a spelling. Renaming
// freePort(), or rewriting it as `export const freePort = () =>`, makes the guard refuse its own
// tree. Moving login-harness.ts moves the mark with it and refuses the tree left behind. Loud in
// every case, never silent, which is the whole reason it is acceptable. An explicit sentinel line
// in tests/auth would not hang on that name — but it would have to be written into
// tests/auth/login-harness.ts, and it marks whatever file it is copied into; the definition can
// only be in one place, because a second `export function freePort` would not compile into the
// same module graph twice by accident.
// What the marker does NOT cost: it does not decide whether a tree is scanned, only whether a
// clean scan may report success (see the gate below), so a tree that slips it is still scanned
// whole, and an unmarked tree holding a literal is named by file and line AND told it is the wrong
// tree. Both notices, pinned in tests/plugin/bound-port-literals-guard.test.ts.
const DEFINES_FREE_PORT = /\bexport (async )?function freePort\(/;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Exactly one, not "at least one": a second root used to be dropped without a word, so
// `check:ports tests/auth tests/plugin` would have guarded half of what it named and said nothing.
if (process.argv.length !== 3) {
  console.error('Expected exactly one scan root: node scripts/assert-no-bound-port-literals.mjs <dir>');
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

// Repo-relative in every case, so the output is deterministic wherever the caller's directory or
// TMPDIR happens to sit: `tests/auth/login-harness.ts:12` in a CI log is what has to be clickable.
const show = (file) => relative(root, file) || '.';

let entries;
try {
  entries = readdirSync(target);
} catch (err) {
  // A message, not a stack trace. Ablated, this prints 17 lines: a node:fs source excerpt, the
  // Error, five stack frames, the errno object and the node banner. The sibling guard is held to
  // the same bar (tests/plugin/executor-safety-guard.test.ts, "Nothing to inspect").
  console.error(`Cannot scan ${target}: ${err.code ?? err.message}.`);
  process.exit(1);
}

const files = entries.filter((f) => f.endsWith('.ts')).sort();
const sources = [];
for (const file of files) {
  const path = join(target, file);
  try {
    sources.push([path, readFileSync(path, 'utf8')]);
  } catch (err) {
    // Exit 2, not 1. An unreadable entry — a mode-000 file, or a directory named `x.ts` — used to
    // crash here with exit 1, the very code that means "a fixed port was found". "Could not look"
    // must not be spelled like "looked and found"; tests/auth/login-harness.ts draws the same line
    // in its probe child, 1 for the expected refusal and 2 for every other failure.
    console.error(`Cannot read ${show(path)}: ${err.code ?? err.message}.`);
    process.exit(2);
  }
}

// THE MARKER GATES SUCCESS, NOT THE SCAN. It used to return before the scan, which made an
// unmarked tree holding deps(18000) report "wrong tree" and no file, no line — louder than
// nothing, but not what #73 scenario 3 asks for. Every tree is scanned now and every finding is
// named; the marker only decides whether a clean result is allowed to mean anything. Scenario 2
// is untouched by that: an unmarked tree still never exits 0, with findings or without.
const marked = sources.some(([, source]) => DEFINES_FREE_PORT.test(source));

const findings = sources.flatMap(([path, source]) =>
  [...source.matchAll(BIND_CALL)]
    .filter(([, , literal]) => isBindablePort(literal))
    .map((m) => `${show(path)}:${source.slice(0, m.index).split('\n').length} ${m[1]}(${m[2]})`),
);

// Printed in every outcome, pass or fail: a green line that names the tree and the count is the
// only way a reader can tell "clean" from "looked at almost nothing". On stderr when the tree is
// not the guarded one: a run that ends in 1 must leave nothing on stdout that reads like a report.
(marked ? console.log : console.error)(
  `Bound port literals in ${show(target)}/: ${files.length} files scanned.`,
);

if (findings.length > 0) {
  console.error('\nRefusing the tree: a bind call names a fixed port.');
  for (const finding of findings) console.error(`  - ${finding}`);
  console.error(
    '\nA fixed port collides with a concurrent `vitest run` (#23). Acquire one instead:' +
      '\n  const port = freePort();\n',
  );
}

// Both notices, never one: findings alone would make a run aimed at the wrong tree by accident
// look like an ordinary hit, and the reader would fix the fixture instead of the argument.
if (!marked) {
  console.error(`Not the guarded tree: no file directly in ${show(target)} defines freePort().`);
  console.error(`${files.length} .ts file(s) looked at. A tree that does not own the port allocator is`);
  console.error('not the tree this guard is for, so a clean result here would mean nothing.');
  console.error('Name the tree to scan, for example tests/auth.');
}

if (findings.length > 0 || !marked) process.exit(1);

console.log('Every bound port is acquired, none is written as a literal.');
