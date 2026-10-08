// scripts/assert-executor-safety.mjs
// Structural guard for the defect class behind #9, not for its instance.
//
// THE RULE IS CHEAP. ITS EDGES, THE CHOICE OF TREE AND WHAT WAS ACTUALLY READ ARE WHAT IS
// EXPENSIVE. The rule is one line of code — `const inspect = nested || asyncExecutor` — and has
// not moved since #11. What the rounds since have cost is everything AROUND it: where "synchronous
// path" stops (LIMITS), which directory the walk is pointed at (#76, #87), and whether every file
// collected from that directory was read at all (#85). Read THE RULE once, then LIMITS, the mark
// and the unread refusal — that is where the surprises are.
//
// What happened (#9): `server.listen(port)` sat on the synchronous path of an INNER executor in
// src/auth/oauth-flow.ts. An out-of-range port makes node throw SYNCHRONOUSLY; the throw rejected
// the INNER promise, which hung on a `.catch(() => {})`, while the OUTER promise's resolve/reject
// were never called. Login is serialized, so every later login hung forever. `server.on('error')`
// cannot help — a synchronous throw never becomes an 'error' event — and 100% line coverage on
// that file missed it, because v8 counts that a statement RAN, not where its exits went.
//
// THE RULE. A synchronous throw in an executor is harmless exactly when the promise that absorbs
// it is the promise the caller holds. The Promise constructor gives that for free in ONE case: a
// plain, non-async executor at top level. So an executor is INSPECTED when it is
//
//   - NESTED on the synchronous path of another executor — its throw rejects the inner promise; or
//   - ASYNC — its throw lands in the async function's discarded return promise. Measured: the
//     outer promise never settles and the process does NOT crash. Same symptom as #9, no nesting.
//
// In an inspected executor every call on the synchronous path must sit inside a try whose catch
// settles the promise that is actually awaited: an enclosing executor's resolve/reject when
// nested, its own when it is an async top level. A bare `throw` is NOT enough — that is the bug.
//
// DENY BY DEFAULT, no allowlist. A curated list of dangerous callees would miss precisely what bit
// us twice: a foreign call nobody thought of. So yes, `console.log(n)` inside an inspected
// executor is reported. That is the pressure: one try around the body answers all of them at once.
//
// BINDINGS, NOT NAMES. Settlers, own parameters and executor identity go through the TypeScript
// binder, so a shadowing `reject` is not mistaken for the outer one, a local `function
// createServer` inherits no exemption, and `router.resolve(p)` does not count as settling.
//
// LIMITS, named so the next reader does not think these were checked:
//   - Only `new Promise(…)` written with the identifier `Promise`. Aliased through a variable it
//     is invisible. That does not happen by accident.
//   - Calls are not followed into callbacks, and the outcomes there differ. A throw in a
//     `setTimeout`/emitter callback becomes an uncaughtException and kills the process — not a
//     wedge, but not harmless; src/auth/oauth-flow.ts records that incident. A throw in a `.then`
//     callback wedges the outer promise silently (measured: never settles, no crash), which is
//     the same class as #9 and this walk does not see it.
//   - A settling catch is credited to the whole try block, so a call added to it later inherits
//     the protection. That is the point of wrapping, not an oversight.
//   - Inside a SETTLING CATCH BLOCK the settle expression is exempt as a whole, arguments
//     included. That is the one exemption in the file; it is justified where it is applied.
//
// AND IT REFUSES A TREE IT COULD NOT FULLY READ (#85). Two kinds of unread, both refused by name
// before the walk starts, both measured green-at-exit-0 before this: a collected file the compiler
// could not OPEN, and a collected file that does not PARSE — where the AST stops at the breakage
// and every executor below it is invisible. Semantic diagnostics are NOT part of that; the numbers
// and the reason are at the check itself.
//
// THE CALLER NAMES THE TREE (#76). argv[2], no default. While the default was 'src' a run aimed
// anywhere else still reported success, so "scanned the wrong tree" and "found nothing" produced
// the same green.
//
// THE MARK OF THE GUARDED TREE: the root must DIRECTLY contain server.ts, the module `npm run
// build` bundles — the code that ships, and nothing else here. Count it with
//   git ls-files '*/server.ts' 'server.ts'
// measured on dd6e564: src/server.ts, 1 directory out of the 27 holding a tracked .ts file
// (`git ls-files '*.ts' | xargs -n1 dirname | sort -u | wc -l`). That command is run by
// tests/plugin/executor-safety-guard.test.ts, so the claim cannot rot on paper.
//
// Why a mark at all, when the walk is RECURSIVE and a too-WIDE root still inspects the guarded
// file? Because the misedit that HIDES something is the narrow one, and narrow is silent:
// `src/auth` and `tests/util` both exited 0 before this mark existed. A count cannot refuse, and
// a floor under it would be a number that rots on the next merge. As in the sibling guard the
// mark gates SUCCESS, not the scan — an unmarked tree is still walked whole and every finding
// still named, it just never exits 0. The one cost: this hangs on a filename. Move or rename
// src/server.ts and the guard refuses its own tree, loudly, in the same commit that breaks
// `npm run build`, which names that exact path.
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import ts from 'typescript';

const ENTRY = 'server.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Exactly one, not "at least one": a second root would be dropped without a word, so
// `check:executors src src/bin` would have guarded half of what it named and said nothing.
// The empty string is not a root either: it resolves to the repo root and walks node_modules,
// whose executors are nobody's business here. The sibling guard refuses it too.
if (process.argv.length !== 3 || !process.argv[2]) {
  console.error(
    'Expected exactly one scan root, and not the empty string:' +
      ' node scripts/assert-executor-safety.mjs <dir>',
  );
  process.exit(1);
}
// Resolved against the repo root, so a relative argument is convenient and an absolute one (the
// tests hand it temp trees) is honoured rather than silently appended to the root.
const target = resolvePath(root, process.argv[2]);

const SOURCE = /\.(ts|tsx|mts|cts)$/;
const DECLARATION = /\.d\.(ts|mts|cts)$/;

// SYMLINKED DIRECTORIES ARE FOLLOWED, and a cycle is survived rather than broken. An earlier
// header claimed the opposite — that the walk does not descend, so no cycle could reach ELOOP —
// and that was false on every runtime (#77, re-measured on node 20.20.2 and 26.5.0). It descends.
// What saves it is the OS, not the walk: the open is refused once the symlink chain is too long
// and node drops that branch silently, so the listing TERMINATES. The cost is the counts, not the
// findings: a file behind a cycle is collected once per level, so executors and findings in it are
// reported repeatedly. Nothing is hidden and the exit code is right; the inventory repeats. To see
// it, build a tree of one nested-executor file plus `sub/loop -> .` and run this guard over it;
// the entry count alone comes from
//   node -e 'console.log(require("node:fs").readdirSync(process.argv[1],{recursive:true}).length)' <tree>

// A message, not a stack trace, and ONE sentence for every way a named root refuses to be read:
// a missing directory (ENOENT), a FILE named as the root (ENOTDIR — which used to print a node:fs
// excerpt and a trace), and a listable-but-unstattable root (EACCES), which reaches the lstat on
// the mark far below rather than this walk. The last fallback is for a throw that is neither:
// `??` on `.code` alone printed `(undefined)`. Asserted by shape rather than by a frame count
// (#91), in both guards' tests. The sibling guard writes the same three-way fallback since #110;
// until then it wrote `err.code ?? err.message` and raised a TypeError of its own on a thrown
// null or undefined — the stack trace this paragraph exists to prevent.
// Repo-relative where that is shorter, absolute where it is not. `relative()` alone answered a
// tree under /var/folders with six `../` segments, which is longer than the path it replaced and
// harder to paste back into a command.
const rel = (p) => {
  const r = relative(root, p);
  return !r || r.startsWith('..') ? p : r;
};

// `subject` names what refused, because the per-file caller below is not talking about the root.
// Measured: without it, a file the walk could not stat was reported as `Nothing to inspect: <root>`,
// which is the one thing #85 asks the guard not to do — name the tree instead of the file.
const unreadable = (err, subject = target) => {
  console.error(`Nothing to inspect: ${subject} (${err?.code ?? err?.message ?? err}).`);
  process.exit(1);
};

let entries;
try {
  entries = readdirSync(target, { recursive: true });
} catch (err) {
  unreadable(err);
}
const files = entries
  .filter((f) => SOURCE.test(f) && !DECLARATION.test(f))
  .sort()
  .map((f) => join(target, f));

// noLib/noResolve: the binder is all this guard needs, so no lib.d.ts and no node_modules are
// read. `typescript` was already a devDependency — this guard added no dependency.
const program = ts.createProgram(files, {
  target: ts.ScriptTarget.Latest,
  allowJs: false,
  noLib: true,
  noResolve: true,
});
const checker = program.getTypeChecker();

// A FILE THE WALK NEVER SAW MAY NOT BE COUNTED CLEAN (#85). Two ways a collected file drops out of
// the walk without a trace, both measured on dd6e564 over a marked tree holding one wedged
// executor, both printing "0 executors, 0 inspected" and exiting 0:
//
//   1. `chmod 000 w.ts` — ts.createProgram cannot open it, getSourceFile returns undefined, and the
//      old `if (!source) continue;` dropped it in silence.
//   2. an unterminated template literal on line 1 of hidden.ts — the file parses into an AST that
//      simply stops, and every executor below the breakage is gone from the walk. Reproduced with
//      the same content in server.ts itself, i.e. in the marked file.
//
// So both are refused here, before the walk, and each names what was unread. SYNTACTIC diagnostics
// only: the program runs with noLib/noResolve and no project tsconfig, so every semantic
// diagnostic is expected noise. Measured over this repo's own src/ (77 files, dd6e564):
// getSyntacticDiagnostics() → 0, getSemanticDiagnostics() → 933, of which TS2304 "cannot find
// name" 413, TS2583 161, TS2339 173, TS2792 104 — all of them the absence of lib.d.ts and of
// module resolution, on a tree `npm run build` compiles clean. Refusing on those would make the
// guard unrunnable, so the semantic list is deliberately not consulted.
//
// ONLY REGULAR FILES ARE THIS CHECK'S BUSINESS. `readdirSync` lists directories too, so a DIRECTORY
// named server.ts is collected and getSourceFile returns undefined for it — but that tree's defect
// is its mark, not an unread file, and the mark check below already names it ("Not the guarded
// tree"). Same for a dangling symlink. Answering those here instead would replace a precise verdict
// with a vaguer one, and it broke the three cases #76/#77 pinned when this check was first written
// without the lstat. That lstat is reached only by a file that already failed to load, so a healthy
// tree pays nothing for it; when the lstat itself dies — `chmod 444` on the root lists names and
// refuses to stat entries — that is the root-unreadable case #77 raised, handed to its own refusal.
// Every collected entry leaves here in exactly one of three states — walked, refused by name, or
// explicitly not a file, with the link RESOLVED before that last question is asked. There is no
// fourth, and that is the whole point: the silent skip was it.
const unread = [];
const sources = [];
for (const file of files) {
  const source = program.getSourceFile(file);
  if (source) {
    sources.push([file, source]);
    continue;
  }
  // `statSync`, which FOLLOWS the link, and not `lstatSync`, which reports it. A `.ts` symlink
  // whose target the compiler cannot open is an unread source file — lstat said "symlink, not a
  // file" and dropped it, so the hole #85 is about survived one indirection. Measured on a marked
  // tree with `w.ts -> hidden/real.ts`, `chmod 000 real.ts`: lstat gave `0 executors, 0 inspected`
  // and exit 0, the identical green; stat names the file and refuses.
  let stats;
  try {
    stats = statSync(file);
  } catch (err) {
    // ENOENT (dangling) and ELOOP (self-referential) are the two throws that are not read
    // failures: neither names a file the walk could have read, and refusing them would reverse the
    // #76/#77 cases that settled "a dangling symlink is Not the guarded tree, not an unread file".
    // They were asymmetric before — a dangling link was a silent skip, its self-referential twin
    // refused the whole tree.
    if (err?.code === 'ENOENT' || err?.code === 'ELOOP') continue;
    unreadable(err, rel(file));
    // Unreachable: `unreadable` ends in process.exit(1). It stands so that `stats` below is
    // definitely assigned by this block's own shape rather than by a helper's promise to exit.
    continue;
  }
  if (!stats.isFile()) continue;
  unread.push(`${rel(file)}  (could not be read)`);
}
for (const d of program.getSyntacticDiagnostics()) {
  const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
  const at = pos ? `:${pos.line + 1}:${pos.character + 1}` : '';
  const where = d.file ? rel(d.file.fileName) : '(no file)';
  unread.push(`${where}${at}  ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}
if (unread.length > 0) {
  console.error(
    `Refusing the tree: ${unread.length} file(s) under ${rel(target)} could` +
      ' not be read or did not parse, so the walk never saw what is in them.',
  );
  for (const entry of unread) console.error(`  - ${entry}`);
  console.error(
    '\nA guard that denies by default must not credit a file it never read. Fix the permission or' +
      '\nthe syntax error and run again; there is no way to pass with a file missing from the walk.',
  );
  process.exit(1);
}

// Function boundaries for the synchronous walk. Classes are NOT a boundary: a `static {}` block and
// a property initializer run synchronously, so they belong to the path. Their methods do not.
const isFunctionBoundary = (node) =>
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessor(node) ||
  ts.isSetAccessor(node);

// Walks only the synchronous path: every function is a boundary, not a place to recurse. A visitor
// returning false stops the descent into that node — which is how one finding per expression falls
// out for free: `a.map(x).filter(y)` is reported at the outermost call and not walked into.
function walkSync(node, visit) {
  node.forEachChild((child) => {
    if (isFunctionBoundary(child)) return;
    if (visit(child) === false) return;
    walkSync(child, visit);
  });
}

// Every function reached from here, without descending past the first one on each branch.
function eachNestedFunction(node, visit) {
  node.forEachChild((child) => {
    if (isFunctionBoundary(child)) visit(child);
    else eachNestedFunction(child, visit);
  });
}

const symbolOf = (node) => (node ? checker.getSymbolAtLocation(node) : undefined);

// The symbol a call settles through, or undefined. Only a bare identifier callee can be a settler:
// `router.resolve(p)` is a property access and never settles anything.
const calleeSymbol = (node) =>
  node && ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    ? symbolOf(node.expression)
    : undefined;

// `new Promise(x)` → the function x denotes, following an identifier to its declaration so that
// `const exec = (res, rej) => {…}; new Promise(exec)` is seen. Returns null for anything else.
function executorOf(node) {
  if (!ts.isNewExpression(node)) return null;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'Promise') return null;
  return asFunction(node.arguments?.[0]);
}

function asFunction(node, seen = new Set()) {
  if (!node || seen.has(node)) return null;
  seen.add(node);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  if (!ts.isIdentifier(node)) return null;
  const declaration = symbolOf(node)?.declarations?.[0];
  if (!declaration) return null;
  if (ts.isFunctionDeclaration(declaration) && declaration.body) return declaration;
  if (ts.isVariableDeclaration(declaration)) return asFunction(declaration.initializer, seen);
  return null;
}

const within = (ranges, node) =>
  ranges.some(([from, to]) => node.getStart() >= from && node.getEnd() <= to);

const isAsync = (fn) => fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;

const problems = [];
const inventory = [];
let inspectedCount = 0;
const visited = new Set();

for (const [file, source] of sources) {
  const where = (node) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${rel(file)}:${line + 1}:${character + 1}`;
  };

  // `ancestors` holds the enclosing executors on the synchronous path, outermost first.
  function visitExecutor(executor, ancestors) {
    if (visited.has(executor)) return;
    visited.add(executor);

    const params = executor.parameters;
    const own = {
      names: params.map((p) => (ts.isIdentifier(p.name) ? p.name.text : '…')),
      symbols: params.map((p) => (ts.isIdentifier(p.name) ? symbolOf(p.name) : undefined)),
      rejectName: params[1] && ts.isIdentifier(params[1].name) ? params[1].name.text : null,
    };
    const nested = ancestors.length > 0;
    const asyncExecutor = isAsync(executor);
    const inspect = nested || asyncExecutor;
    if (inspect) inspectedCount += 1;
    inventory.push(
      `${where(executor)}  (${own.names.join(', ') || '?'})  ` +
        `${[nested && 'nested', asyncExecutor && 'async'].filter(Boolean).join('+') || 'top level'}, ` +
        `${inspect ? 'inspected' : 'not inspected'}`,
    );

    if (inspect) {
      // Whose settle counts: an enclosing executor's when nested (its promise is the awaited one),
      // the executor's own when it is an async top level — there is no enclosing one, and its own
      // reject does reach the caller; only the throw does not.
      const settleTargets = nested ? ancestors : [own];
      const settlers = new Set(settleTargets.flatMap((a) => a.symbols).filter(Boolean));
      const ownSymbols = new Set(own.symbols.filter(Boolean));

      // Try blocks whose catch settles UNCONDITIONALLY — the settle must be a statement of the
      // catch block itself, not hidden inside an `if`. A catch or finally block is not inside its
      // own try, so a foreign call sitting there is still unguarded.
      const safeRanges = [];
      const settlingCatches = [];
      const collect = (node) => {
        if (!ts.isTryStatement(node) || !node.catchClause) return;
        const settles = node.catchClause.block.statements.some((statement) => {
          const expression = ts.isExpressionStatement(statement)
            ? statement.expression
            : ts.isReturnStatement(statement)
              ? statement.expression
              : undefined;
          const call =
            expression && ts.isAwaitExpression(expression) ? expression.expression : expression;
          return settlers.has(calleeSymbol(call));
        });
        if (settles) {
          safeRanges.push([node.tryBlock.getStart(), node.tryBlock.getEnd()]);
          settlingCatches.push([
            node.catchClause.block.getStart(),
            node.catchClause.block.getEnd(),
          ]);
        }
      };
      collect(executor.body);
      walkSync(executor.body, collect);

      const settleName = (nested ? ancestors[ancestors.length - 1] : own).rejectName;
      const check = (node) => {
        if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return true;
        // A nested `new Promise(fn)` is inspected in its own right, not a foreign call here.
        if (executorOf(node)) return true;
        const settler = calleeSymbol(node);
        if (settler && (settlers.has(settler) || ownSymbols.has(settler))) {
          // A settle call is never a foreign call. THE ONE EXEMPTION, and this is its whole
          // justification: inside a settling catch the arguments are exempt too, so a catch may
          // write the honest `reject(err instanceof Error ? err : new Error(String(err)))`. A
          // throw there is a programming error in the one place every review looks, on a path
          // where something has already gone wrong. Everywhere ELSE the arguments are still
          // walked, so `reject(load())` on the ordinary path is reported — `load()` throwing
          // there settles nothing.
          return !within(settlingCatches, node);
        }
        if (within(safeRanges, node)) return true;
        problems.push({
          at: where(node),
          call: node.getText(source).replace(/\s+/g, ' ').slice(0, 90),
          nested,
          settleName,
        });
        return false;
      };
      if (check(executor.body) !== false) walkSync(executor.body, check);
    }

    // Deeper executors on this synchronous path inherit the chain.
    walkSync(executor.body, (node) => {
      const inner = executorOf(node);
      if (inner) visitExecutor(inner, [...ancestors, own]);
    });
    // Anything created inside a callback runs after this executor returned: a fresh top level.
    eachNestedFunction(executor.body, findRoots);
  }

  function findRoots(node) {
    node.forEachChild((child) => {
      const executor = executorOf(child);
      if (executor) visitExecutor(executor, []);
      findRoots(child);
    });
  }

  findRoots(source);
}

const show = rel(target);

// THE MARK IS A FILE THIS WALK COLLECTED, not a path that merely exists. `existsSync` said yes to
// three things that are not the module the build bundles: a DIRECTORY named server.ts; a
// `Server.ts`, because existsSync case-folds on darwin — one tree, two verdicts by platform,
// green locally and red on Linux CI; and a server.ts symlinked outside the scanned tree. Asking
// the collected list fixes the spelling for free, since the entries carry the real on-disk name,
// and lstat — not stat — refuses the symlink without following it. A DANGLING symlink stays
// refused: lstat succeeds, isFile() is false. Each of the four is a case in the guard's tests.
const ENTRY_PATH = join(target, ENTRY);
// lstat is the one read left outside the walk, so it is the one read that can still die on a root
// the walk survived: `chmod 444` on a directory lists its names and refuses to stat its entries.
// ts.createProgram above needs no such guard — losing the cwd kills node in bootstrap before this
// script's first line, so a catch there would be unreachable.
let marked = false;
try {
  marked = files.includes(ENTRY_PATH) && lstatSync(ENTRY_PATH).isFile();
} catch (err) {
  unreadable(err);
}

// Printed in EVERY outcome: a gate that only speaks when it is happy leaves a red build with no
// record of what was looked at. THE STREAM IS KEYED ON THE MARK, NOT ON THE EXIT CODE: the
// inventory of the GUARDED tree is a true record whether the verdict is green or red, while a
// summary of a tree that was never the subject must not sit on stdout reading like one. Keying it
// on the verdict was tried and dropped — it merges inventory and findings onto one stream, where
// neither a reader nor the assertions that count `file:line:col` occurrences can tell them apart.
const report = marked ? console.log : console.error;
report(`Promise executors in ${show}/: ${inventory.length} executors, ${inspectedCount} inspected.`);
for (const entry of inventory) report(`  - ${entry}`);

if (problems.length > 0) {
  console.error('\nRefusing the tree: an inspected promise executor calls out unguarded.');
  for (const p of problems) {
    console.error(`  - ${p.at}  ${p.call}`);
    console.error(
      p.nested
        ? '      A synchronous throw here rejects only the INNER promise. The outer one — the one' +
            ' the caller awaits — never settles, and every caller waiting on it hangs (see #9).'
        : '      This executor is async, so a synchronous throw here is absorbed by the async' +
            " function's discarded return promise. The promise the caller awaits never settles.",
    );
  }
  const { settleName, nested } = problems[0];
  console.error(
    settleName
      ? '\nSettle the promise that is actually awaited:\n' +
          `  try {\n    theCall();\n  } catch (err) {\n    ${settleName}(err);` +
          '   // a bare `throw` only rejects the wrong promise\n  }\n'
      : `\nThe ${nested ? 'enclosing' : 'async'} executor declares no reject parameter, so there is` +
          ' nothing here to settle it with.\nGive it one — `(resolve, reject) => …` — and call it' +
          ' from the catch. Do NOT reach for the resolver: resolving\nwith an Error settles the' +
          ' promise with the error as its VALUE, which is a second defect.\n',
  );
  console.error(
    nested
      ? 'PREFER moving the call out to the enclosing top-level executor, where a synchronous throw\n' +
          'already rejects the promise the caller awaits. That is what fixed #9, and it leaves one\n' +
          'settle path instead of two. Wrapping the body in a try is the fallback for a call that\n' +
          'genuinely has to stand where it stands — it answers every call in the body at once.\n' +
          'There is no per-call exemption on purpose: the calls nobody thought of are the ones that bite.'
      : 'There is no enclosing executor to move this call into — an async executor IS the top level.\n' +
          'Wrapping the body in a try with a settling catch is the remedy here, and it answers every\n' +
          'call in the body at once. There is no per-call exemption on purpose: the calls nobody\n' +
          'thought of are the ones that bite.',
  );
}

// Both notices, never one: findings alone would make a run aimed at the wrong tree by accident
// look like an ordinary hit, and the reader would fix the fixture instead of the argument.
if (!marked) {
  console.error(`\nNot the guarded tree: ${show}/ does not directly contain ${ENTRY}.`);
  console.error(`${files.length} file(s) looked at. A tree that is not the one the build bundles is`);
  console.error('not the tree this guard is for, so a clean result here would mean nothing.');
  console.error('Name the tree to scan, for example src.');
}

if (problems.length > 0 || !marked) process.exit(1);

console.log('Every call on an inspected executor path is on a settling path.');
