// scripts/assert-no-bound-port-literals.mjs
// A fixed port on a bind call collides with a concurrent `vitest run` (#23); use freePort().
//
// THE RULE IS CHEAP. CHOOSING THE TREE IS WHAT IS EXPENSIVE. BIND_CALL below is one line and has
// not changed in three rounds. WHICH DIRECTORY it is pointed at has cost #72, #73, #75, #82 and
// an owner decision. Everything below the regex is about the tree, and that is where to read.
//
// ONE ROOT, NAMED BY THE CALLER (#73). argv[2], no default: a guard that picks its own directory
// reports "scanned the wrong tree" and "found nothing" the same way (PR #72, mutation M3).
//
// EVERY TEST, AT EVERY DEPTH (#82). Before it the root was tests/auth and the scan one level
// deep — about a quarter of the tree, green on the rest unseen. The scan is recursive now and
// package.json names `tests`, so one argument covers every depth and no hand-kept list of roots
// can go stale.
//
// TEST-ONLY, DECIDED RATHER THAN ASSUMED (#82). src/ is NOT scanned and must not be: the rule is
// about parallel `vitest run` collisions, which production code is not subject to. src/
// legitimately carries a fallback (src/auth/config.ts:13). Production ports belong to a
// configuration review, not to this script.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';

// Text matching, so evadable by construction. Blind spots, all deliberate: only the call names
// below are matched; only a decimal literal at the call site is read, so a const, a variable,
// 18e3, 0x4650, a computed port and an option bag are not traced; and an expression is reported by
// its FIRST literal, because the call site is what a reader has to fix and tightening the match
// trades a loud wrong number for silence. A literal in a comment or a string counts, so the
// guards' own test files write their samples split. A .d.ts is NOT excluded — a fixed port in a
// doc comment is a literal someone will copy. The rest needs a parser or a runtime check, and #74
// built the second one: tests/setup/no-fixed-bind-port.ts takes the NUMBER at the bind, whatever
// spelling it arrived in, but only on a path a test actually runs. Neither half subsumes the
// other, and that file carries the comparison.
const BIND_CALL = /\b(waitForAuthorizationCode|startCallbackListener|listenOn|listen|rebind|config|deps)\(\s*(\d[\d_]*)\b/g;

// EVERY SPELLING A TEST SOURCE CARRIES (#82 follow-up). The filter was `.ts`, so
// tests/plugin/executor-guard-property.mjs sat in this root with nothing looking at it. The JS
// spellings are added rather than the sibling guard's `ts|tsx|mts|cts` copied, because .mjs is the
// spelling that occurs here and that list would have left out the very file that prompted this.
// That file holds no bind literal (measured on 35f4c5d: 0 matches), so this made the promise true
// rather than closing an open hole.
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

// THE MARK OF THE GUARDED TREE: the tree that CONTAINS the allocator's definition, not one that
// merely mentions it. A mention travels with every caller, so "some file here CALLS freePort()"
// let three wrong roots exit 0. The mark is recursive like the scan, so the marked roots are the
// defining directory and its ancestors. Count the directories that carry the definition with
//   git ls-files '*.ts' | xargs grep -lE '\bexport (async )?function freePort\(' \
//     | xargs -n1 dirname | sort -u
// measured on 35f4c5d: 1, tests/auth — against 4 for the weaker `\bfreePort\(` mention.
// tests/plugin/bound-port-literals-guard.test.ts runs this pipeline and asserts all THREE of its
// parts against this header — the selector, the grep and the tail — so none can drift here
// without going red. It asserted two of the three until #79, which read as complete and was not.
//
// Why a mark at all, and why the extraction to scripts/lib/scan-root.mjs is refused (#112):
// ops/projects/zendesk-plugin/decisions/2026-10-08-guard-mark-rationale-and-refused-extraction.md
//
// The one cost, named rather than discovered later: this hangs on a name and a spelling. Renaming
// freePort(), rewriting it as `export const freePort = () =>`, or moving login-harness.ts out all
// make a guard refuse a tree. Loud in every case, never silent, which is why it is acceptable.
const DEFINES_FREE_PORT = /\bexport (async )?function freePort\(/;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Exactly one, not "at least one": a second root used to be dropped without a word, so
// `check:ports tests/auth tests/plugin` would have guarded half of what it named and said nothing.
// The empty string is not a root either — `resolve(root, '')` is the repository root, which a
// recursive scan walks whole, node_modules included. The sibling guard refuses it too (#76).
//
// OPEN, DELIBERATELY: `.`, `./` and the absolute repository path ARE accepted. All three are
// ancestors of the allocator and so marked by design, they scan more than the wired root and can
// therefore hide nothing, and with dependencies installed they are loud rather than silent — run
//   node scripts/assert-no-bound-port-literals.mjs .
// (measured on 35f4c5d: exit 1, and every finding is somebody else's documentation under
// node_modules). CARE WHEN EDITING THIS FILE: `.` reaches scripts/ because the filter takes .mjs,
// so a call-shaped literal in the prose here becomes a finding of the guard's own — it did twice,
// and isBindablePort's comment below is one digit from doing it again. Narrowing back to
// `tests/auth` is not silent either, although nothing refuses it at runtime: the wiring in
// package.json is pinned by bound-port-literals-guard.test.ts.
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

// Repo-relative, because a CI log line has to be clickable. A path outside the repository — the
// tests hand this temp trees — is named by its way out (`../…`), not by an absolute path that
// changes with TMPDIR.
const show = (file) => relative(root, file) || '.';

// RECURSIVE SINCE #82: entries come back relative to the root at every depth. Symlinked
// directories ARE followed, and a cycle is survived rather than broken — the OS refuses the open
// once the chain is too long, so the cost is a repeated inventory, never a missed finding.
let entries;
try {
  entries = readdirSync(target, { recursive: true });
} catch (err) {
  // A message, not a stack trace: ablated, node prints a node:fs source excerpt and a trace.
  // Asserted by shape rather than by a frame count (#91), in both guards' tests.
  // EVERY READ OF `err` IS CHAINED (#110). A thrown `null` or `undefined` is not an Error, so
  // `err.code` raised `TypeError: Cannot read properties of null` here — the stack trace these
  // lines exist to prevent. The third fallback prints the thrown value itself, because `?.` alone
  // answers `undefined`. Driven by tests/plugin/port-guard-error-paths.test.ts.
  console.error(`Cannot scan ${target}: ${err?.code ?? err?.message ?? err}.`);
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
    // directory whose name ends in a source extension, so the widened filter matches it and the
    // gate exited 2 before printing a line. Skipping costs nothing: readdirSync already walked
    // into it, so its contents are in `entries` and are scanned on their own.
    if (err?.code === 'EISDIR') continue;
    // Exit 2, not 1, for everything else — a mode-000 file, a dangling symlink. 1 means "a fixed
    // port was found", so "could not look" must not be spelled like "looked and found".
    // tests/auth/login-harness.ts draws the same line in its probe child. Chained like the
    // `Cannot scan` line above, and so is the `EISDIR` comparison it sits below (#110).
    console.error(`Cannot read ${show(path)}: ${err?.code ?? err?.message ?? err}.`);
    process.exit(2);
  }
}

// THE MARKER GATES SUCCESS, NOT THE SCAN (#73 scenario 3). It used to return before the scan, so
// an unmarked tree holding a fixed port reported "wrong tree" with no file and no line. Every
// tree is scanned now and every finding is named; the marker only decides whether a CLEAN result
// may mean anything. An unmarked tree still never exits 0, with findings or without.
const marked = sources.some(([, source]) => DEFINES_FREE_PORT.test(source));

const findings = sources.flatMap(([path, source]) =>
  [...source.matchAll(BIND_CALL)]
    .filter(([, , literal]) => isBindablePort(literal))
    .map((m) => `${show(path)}:${source.slice(0, m.index).split('\n').length} ${m[1]}(${m[2]})`),
);

// Printed in every outcome: naming the tree and the count is the only way a reader tells "clean"
// from "looked at almost nothing". On stderr when the tree is not the guarded one — a run ending
// in 1 must leave nothing on stdout that reads like a report. The count is what was READ, not
// what matched the filter, so a skipped directory is not reported as a file somebody looked at.
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
