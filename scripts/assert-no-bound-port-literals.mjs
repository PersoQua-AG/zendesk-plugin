// scripts/assert-no-bound-port-literals.mjs
// A fixed port on a bind call collides with a concurrent `vitest run` (#23); use freePort().
//
// THE CALLER NAMES THE TREE (#73). The scan root is argv[2] and there is no default. Measured on
// PR #72, mutation M3: while the guard chose its own directory, bending that choice to another
// directory still reported success — "scanned the wrong tree" and "found nothing" produced the
// same green. Here there is no directory constant to bend, and a root that is not the guarded
// tree is refused instead of reported clean.
//
// THE TREE IS EVERY TEST (#82). The root was tests/auth and the scan was one directory deep, so
// 142 of 190 test files were never looked at — among them every test added by #68 and #80. The
// gap is closed by widening what ONE root means, not by naming more roots: the scan is recursive
// and `package.json` names `tests`. That keeps #73 literally intact — still exactly one argument,
// still no default, nothing to bend — where `… tests/auth && … tests/tools && … tests/plugin`
// would have needed the arity rule rewritten AND would have gone stale on the next directory, which
// is precisely how this gap appeared. A hand-kept list cannot know what the next merge creates.
//
// TEST-ONLY, DECIDED RATHER THAN ASSUMED (#82). src/ is NOT scanned and must not be. The rule here
// is "a bind call must not name a fixed port, because a concurrent `vitest run` collides on it
// (#23)" — a statement about test parallelism, which production code is not subject to. src/
// legitimately carries a default to fall back on: src/auth/config.ts:5,
// `DEFAULT_CALLBACK_PORT = 8976`. It is a value, not a bind call, so today's BIND_CALL would not
// match it — but the regex not firing is luck, not a decision, and `config(8976)` in src/ would be
// correct code this guard would refuse. Production ports belong to a configuration review, not to
// this script.
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
//   - a mention in a comment or a string counts, and #82 put the guard's own test file INSIDE the
//     scanned tree, so the sample literals there are written split again — once, in a constant,
//     exactly as the predecessor in tests/auth had to. That cost was dropped while the root was
//     tests/auth and is taken back deliberately: it is the price of scanning every test instead
//     of one directory, and it is paid by two files (measured, both named in PR #82);
//   - the scan is recursive (#82): every .ts under the given root, at any depth. A .d.ts is NOT
//     excluded, because a declaration file carrying `listen(18000)` in a doc comment is a literal
//     someone will copy.
// Catching the rest needs a parser or a runtime check, not a wider regex (out of scope, #74).
const BIND_CALL = /\b(waitForAuthorizationCode|startCallbackListener|listenOn|listen|rebind|config|deps)\(\s*(\d[\d_]*)\b/g;

// THE MARK OF THE GUARDED TREE: the tree that CONTAINS the definition of the port allocator, not
// one that merely mentions it. The mark survives #82 unchanged in intent and in regex; only its
// reach follows the scan, from "directly in the root" to "anywhere under the root", because a
// recursive scan whose mark was not recursive would refuse `tests` — the very root it now needs.
//
// WHY A MARK AT ALL, once the root is the whole test tree. The direction of danger flipped, and the
// mark answers the new direction as well as the old. While the scan was one directory deep the
// dangerous misedit was the WIDE one: naming `tests` scanned the four files sitting directly in it,
// missed all 50 of tests/auth, and reported success. Recursion kills that class outright — a root
// too wide now scans MORE, and can hide nothing. What is left is the NARROW misedit, and narrow is
// silent without a mark: measured on b9f0615, `tests/plugin` holds 12 .ts files and `tests/tools`
// holds 78, and a clean scan of either would read exactly like a clean scan of all 197. The mark
// refuses both (neither contains the definition), and that is the same reasoning the sibling guard
// records for #76/PR #87, reached from the opposite starting point.
//
// "Holds .ts files" still does not identify a tree, and a minimum file count still cannot: both are
// properties every candidate shares. What separates them is the thing the guarded tree is guarded
// FOR. The previous spelling of that — "some file here CALLS freePort()" — did not survive one day:
// PR #71 (dc2ae3e) added 53 test files that call it, and three wrong roots then exited 0. A mention
// travels with every caller; the definition does not. Count the directories carrying the definition
// over every tracked .ts file in the repo with
//   git ls-files '*.ts' | xargs grep -lE '\bexport (async )?function freePort\(' \
//     | xargs -n1 dirname | sort -u
// Measured on b9f0615 by running exactly that command: **1** directory, tests/auth, in
// login-harness.ts — against 4 that match the weaker `\bfreePort\(` mention. The marked ROOTS are
// therefore that directory and its ancestors, measured as `.`, `tests` and `tests/auth`, out of the
// 27 directories that hold a tracked .ts file. That claim is not left on paper: the counting command
// is executed by tests/plugin/bound-port-literals-guard.test.ts, "runs the counting command from the
// script header", and the marked set is swept there rather than listed by hand. It is pinned because
// it was wrong three times in #73 — every time because the guard's own test file wrote the marker
// whole into a fixture constant and thereby marked tests/plugin. That constant is split on purpose.
// The one cost, named rather than discovered later: this hangs on a name and a spelling. Renaming
// freePort(), or rewriting it as `export const freePort = () =>`, makes the guard refuse its own
// tree. Moving login-harness.ts out of the test tree refuses the tree left behind. Loud in every
// case, never silent, which is the whole reason it is acceptable. An explicit sentinel line would
// not hang on that name — but it marks whatever file it is copied into, whereas the definition can
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
// The empty string is not a root either, and #82 is what makes that worth a clause: `resolve(root,
// '')` is the repository root, which was harmless while the scan was one directory deep — measured
// on b9f0615, `node scripts/assert-no-bound-port-literals.mjs ""` scanned 0 .ts files. Recursive,
// the same argument walks the whole checkout: measured on b9f0615 with dependencies installed,
// 1909 .ts files, 1634 of them under node_modules, and 21 findings there — the first is
// `node_modules/@types/node/async_hooks.d.ts:97 listen(3000)`, somebody else's documentation. And
// `.` IS a marked root, so such a run reads like a report about this repository's tests.
// The sibling guard refuses it for the same reason (#76, PR #87).
if (process.argv.length !== 3 || !process.argv[2]) {
  console.error(
    'Expected exactly one scan root, and not the empty string:' +
      ' node scripts/assert-no-bound-port-literals.mjs <dir>',
  );
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

// RECURSIVE SINCE #82. The entries come back as paths relative to the root, at every depth, so a
// literal in tests/tools or tests/plugin is seen; before this, 142 of 190 test files were not.
// Symlinked directories are followed by node's own walk on the pinned runtime (>=20) — the sibling
// guard measured that for #76 — and a cycle is survived rather than broken, because the OS refuses
// the open once the chain is too long and node drops that branch silently. The cost of a cycle is a
// repeated inventory, never a missed finding.
let entries;
try {
  entries = readdirSync(target, { recursive: true });
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
