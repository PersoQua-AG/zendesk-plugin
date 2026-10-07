// scripts/assert-no-bound-port-literals.mjs
//
// THE RULE IS CHEAP. CHOOSING THE TREE IS WHAT IS EXPENSIVE.
//
// The rule is one regex at BIND_CALL, unchanged since PR #72; which DIRECTORY it is pointed at has
// since cost three rounds, two blockers and an owner decision. Changing what counts as a bind is a
// small edit next to one constant; changing what gets scanned means reading all of "choosing the
// tree" first, because every paragraph in it is a wrong root that shipped.
//
// THE RULE. A fixed port on a bind call collides with a concurrent `vitest run` (#23); use
// freePort().
//
// CHOOSING THE TREE, AND WHAT IT COST.
//
// ONE ROOT, NAMED BY THE CALLER (#73). The scan root is argv[2] and there is no default, because a
// guard that picks its own directory reports "scanned the wrong tree" and "found nothing" the same
// way (measured on PR #72, mutation M3). Exactly one, and not the empty string; the argument check
// below records both refusals and which spellings are let through anyway.
//
// EVERY TEST, AT EVERY DEPTH (#82). The root was tests/auth and the scan was one directory deep, so
// 142 of 190 test files were never looked at. The gap is closed by widening what ONE root means:
// the scan is recursive and package.json names `tests`. Still exactly one argument, nothing to
// bend, and no hand-kept list of roots to go stale on the next merge.
//
// TEST-ONLY, DECIDED RATHER THAN ASSUMED (#82). src/ is NOT scanned and must not be. The rule is
// "a bind call must not name a fixed port, because a concurrent `vitest run` collides on it (#23)"
// — a statement about test parallelism, which production code is not subject to. src/ legitimately
// carries a default to fall back on: src/auth/config.ts:13, `DEFAULT_CALLBACK_PORT = 8976`.
// Production ports belong to a configuration review, not to this script.
//
// AND THE TREE MUST PROVE IT IS THE RIGHT ONE. A wrong root is silent, so success is gated on a
// mark: the tree must CONTAIN the definition of freePort(), not merely mention it. The mark, the
// one false pass it replaced, the command that counts the defining directories and the cost the
// mark brings are all at DEFINES_FREE_PORT; what the scan deliberately cannot see is at BIND_CALL,
// on the regex that is evaded. Pointers rather than second copies — the header grew every round
// because each paragraph restated the block it pointed at (#79).
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';

// THE BLIND SPOTS IN FULL. Only the call names listed below match, and
// only a decimal literal at the call site is read — a const, a variable, 18e3, 0x4650, a computed
// port and an option bag such as `listen({ port: 8976 })` all pass. An expression is reported by
// its FIRST literal, so `17_000 + 1_000` is flagged as 17_000: the call site wins over the number,
// because tightening the match would trade a loud wrong number for silence and for new misses on
// `18000 as Port`. A literal in a comment or a string counts, which since #82 puts the guard's own
// test file inside the scanned tree: its samples are written split, and so is the one in
// executor-safety-guard.test.ts. A .d.ts is deliberately NOT excluded — `listen(18000)` in a doc
// comment is a literal someone will copy.
const BIND_CALL = /\b(waitForAuthorizationCode|startCallbackListener|listenOn|listen|rebind|config|deps)\(\s*(\d[\d_]*)\b/g;

// EVERY SPELLING A TEST SOURCE CARRIES (#82 follow-up). The filter was `.ts`, and the promise is
// "every test file": tests/plugin/executor-guard-property.mjs (added by #87, 316 lines) sat inside
// this root with nothing looking at it. No bind literal in it today, so this is the promise being
// made true, not a hole being closed. The sibling guard's list is `ts|tsx|mts|cts`; it is widened
// here by the JS spellings rather than copied, because .mjs is the spelling that actually occurs
// in this tree and the sibling's list would have left out precisely the file that prompted this.
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

// THE MARK OF THE GUARDED TREE (why it is the definition and not a mention: see the header). A
// mention travels with every caller; the definition does not. The mark is recursive like the scan,
// so the marked roots are the defining directory and its ancestors. Count them with
//   git ls-files '*.ts' | xargs grep -lE '\bexport (async )?function freePort\(' \
//     | xargs -n1 dirname | sort -u
// Measured on b9f0615: **1**, tests/auth, in login-harness.ts — against 4 that match the weaker
// `\bfreePort\(` mention. That claim is not left on paper: the command is executed by
// tests/plugin/bound-port-literals-guard.test.ts, which also sweeps the marked set.
//
// WHY A MARK AT ALL, once the root is the whole test tree: the direction of danger flipped. A root
// too WIDE now scans more and can hide nothing. What is left is the NARROW misedit, and narrow is
// silent without a mark — `tests/plugin` and `tests/tools` would each read exactly like a clean
// scan of all 199 files. The mark refuses both, which is the reasoning the sibling guard records
// for #76/PR #87, reached from the opposite starting point.
//
// The one cost, named rather than discovered later: this hangs on a name and a spelling. Renaming
// freePort(), or rewriting it as `export const freePort = () =>`, makes the guard refuse its own
// tree; moving login-harness.ts out refuses the tree left behind. Loud in every case, never
// silent, which is the whole reason it is acceptable.
const DEFINES_FREE_PORT = /\bexport (async )?function freePort\(/;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Exactly one, not "at least one": a second root used to be dropped without a word, so
// `check:ports tests/auth tests/plugin` would have guarded half of what it named and said nothing.
// The empty string is not a root either — `resolve(root, '')` is the repository root, which a
// recursive scan walks whole (measured on c3ab1c1 with dependencies installed and the directory
// skip below in place: 4109 files scanned, 1910 of them .ts, 1634 .ts under node_modules).
// The sibling guard refuses it too (#76).
//
// OPEN, DELIBERATELY: `.`, `./` and the absolute repository path ARE accepted. All three are
// ancestors of the allocator and therefore marked by design, they scan more than the wired root
// and so can hide nothing, and with dependencies installed they are loud rather than silent —
// measured: exit 1 with 27 findings, 25 of them under node_modules (19 in @types/node alone, all
// of them somebody else's documentation) and 2 in this script's own prose and regex, which `.`
// reaches because the filter now takes .mjs and `tests` never did. Narrowing the root
// back to `tests/auth` is not silent either, although nothing refuses it at runtime: the exact
// wiring in package.json is pinned by tests/plugin/bound-port-literals-guard.test.ts.
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

// Repo-relative where it can be, because `tests/auth/login-harness.ts:12` in a CI log is what has
// to be clickable. A path outside the repository — the tests hand this temp trees — is named by
// its way out of it (`../…`), not by an absolute path that changes with TMPDIR.
const show = (file) => relative(root, file) || '.';

// RECURSIVE SINCE #82. Entries come back relative to the root at every depth, so a literal in
// tests/tools or tests/plugin is seen; before this, 142 of 190 test files were not. Symlinked
// directories are followed by node's own walk on the pinned runtime (>=20) and a cycle is survived
// rather than broken: the OS refuses the open once the chain is too long, so the cost is a
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

const files = entries.filter((f) => SOURCE.test(f)).sort();
const sources = [];
for (const file of files) {
  const path = join(target, file);
  try {
    sources.push([path, readFileSync(path, 'utf8')]);
  } catch (err) {
    // A DIRECTORY IS NOT AN UNREADABLE FILE (#82 follow-up). `node_modules/ipaddr.js` is a
    // directory whose name ends in a source extension, and since the filter grew the JS spellings
    // it matches: the whole gate ended in exit 2 before it printed a single line. Skipping it
    // costs nothing — readdirSync already walked into it, so its contents are in `entries` and are
    // scanned on their own. Decided over naming the limit in prose, because a package named
    // `anything.js` is ordinary and the gate must not be an infrastructure failure next to one.
    if (err.code === 'EISDIR') continue;
    // Exit 2, not 1, for everything else — a mode-000 file, a dangling symlink. An unreadable
    // entry used to crash here with exit 1, the very code that means "a fixed port was found".
    // "Could not look" must not be spelled like "looked and found"; tests/auth/login-harness.ts
    // draws the same line in its probe child, 1 for the expected refusal and 2 for every other
    // failure.
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
// The count is what was READ, not what matched the name filter, so a skipped directory such as
// `node_modules/ipaddr.js` is not reported as a file somebody looked at.
(marked ? console.log : console.error)(
  `Bound port literals in ${show(target)}/: ${sources.length} files scanned.`,
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
  console.error(`Not the guarded tree: nothing under ${show(target)} defines freePort().`);
  console.error(`${sources.length} source file(s) looked at. A tree that does not own the port`);
  console.error('allocator is not the tree this guard is for, so a clean result here would mean');
  console.error('nothing. Name the tree that defines freePort(), the one package.json wires.');
}

if (findings.length > 0 || !marked) process.exit(1);

console.log('Every bound port is acquired, none is written as a literal.');
