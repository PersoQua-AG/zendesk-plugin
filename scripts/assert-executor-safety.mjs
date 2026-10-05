// scripts/assert-executor-safety.mjs
// Structural guard for the defect class behind #9, not for its instance.
//
// What happened: `server.listen(port)` sat on the synchronous path of an INNER promise executor in
// src/auth/oauth-flow.ts. A port outside 0–65535 makes node throw SYNCHRONOUSLY. The throw rejected
// the INNER promise — which hung on a `.catch(() => {})` — while the OUTER promise's resolve/reject
// were never called, so the promise the caller awaited never settled. Login is serialized, so every
// later login hung forever. `server.on('error')` cannot help: a synchronous throw never becomes an
// 'error' event. And 638 tests at 100% coverage on that file missed it, because v8 counts that a
// statement RAN, not where its exits went.
//
// THE RULE. A synchronous throw in an executor is harmless exactly when the promise that absorbs it
// is the promise the caller holds. The Promise constructor gives that for free in ONE case: a
// plain, non-async executor at top level. Everywhere else the throw goes somewhere nobody is
// watching, and the awaited promise never settles. So an executor is INSPECTED when it is
//
//   - NESTED on the synchronous path of another executor — its throw rejects the inner promise; or
//   - ASYNC — its throw lands in the async function's discarded return promise. Measured: the outer
//     promise never settles and the process does NOT crash. Same symptom as #9, no nesting needed.
//
// and in an inspected executor every call on the synchronous path must sit inside a try whose catch
// settles the promise that is actually awaited: an enclosing executor's resolve/reject when nested,
// its own when it is an async top level. A bare `throw` is explicitly NOT enough — that is the bug.
//
// DENY BY DEFAULT, and there is no allowlist. A curated list of dangerous callees would miss
// precisely the thing that bit us twice: a foreign call nobody thought of. Yes, this reports
// `console.log(n)` and `items.map(…).filter(…)` inside an inspected executor. That is the intended
// pressure: wrapping the whole executor body in one try with a settling catch answers all of them
// at once, and that is the shape the code should have.
//
// BINDINGS, NOT NAMES. Settlers, own parameters and executor identity are resolved through the
// TypeScript binder (symbol identity), so a nested `reject` that shadows an outer `reject` is not
// mistaken for it, a local `function createServer` inherits no exemption, and `router.resolve(p)`
// does not count as settling because a parameter happens to be called `resolve`.
//
// Zero new dependencies: `typescript` is already a devDependency. The program is built with
// noLib/noResolve — the binder is all this needs, so no lib.d.ts and no node_modules are read.
//
// LIMITS, named so the next reader does not think these were checked:
//   - Only `new Promise(...)` written with the identifier `Promise`. Aliased through a variable
//     (`const P = Promise; new P(…)`) it is invisible. That does not happen by accident.
//   - Calls are not followed into callbacks, and the two outcomes there differ. A throw inside a
//     `setTimeout`/emitter callback becomes an uncaughtException and kills the process — not a
//     wedge, but not harmless either; src/auth/oauth-flow.ts records that exact incident. A throw
//     inside a `.then` callback wedges the outer promise silently, measured: never settles, no
//     crash. That is the same class as #9 and this walk does not see it.
//   - A settling catch is credited to the whole try block, so a call added to that block later
//     inherits the protection. That is the point of wrapping, not an oversight.
//   - Inside a SETTLING CATCH BLOCK the settle expression is exempt as a whole, its arguments
//     included, so a catch may write the honest `reject(err instanceof Error ? err : new
//     Error(String(err)))`. That is the full extent of the exemption, and it is the full extent of
//     its justification: a throw there is a programming error in the one place every review looks,
//     on a path where something has already gone wrong. Everywhere ELSE a settle call is merely not
//     a foreign call itself — its arguments are still walked, so `reject(load())` on the ordinary
//     path is reported, because `load()` throwing there settles nothing.
// THE CALLER NAMES THE TREE (#76). The scan root is argv[2] and there is no default. While the
// default was 'src', a run aimed anywhere else still reported success: measured on 3ee1d43,
// `node scripts/assert-executor-safety.mjs tests/util` printed "0 executors, 0 inspected" and
// exited 0 — "scanned the wrong tree" and "found nothing" produced the same green.
//
// THE MARK OF THE GUARDED TREE: the root must DIRECTLY contain server.ts, the module `npm run
// build` bundles. That is the tree this guard is for — the code that ships — and it is nothing
// else here: measured on 3ee1d43 by running
//   git ls-files '*/server.ts' 'server.ts'
// → src/server.ts, 1 directory, out of the 27 that hold a tracked .ts file
// (`git ls-files '*.ts' | xargs -n1 dirname | sort -u | wc -l` → measured on 3ee1d43: 27).
// Why a mark at all, when this walk is RECURSIVE and a too-WIDE root therefore still inspects the
// guarded file (measured on 3ee1d43: `node scripts/assert-executor-safety.mjs .` reports
// `src/auth/oauth-flow.ts:149:54  (resolve, reject)  nested, inspected`)? Because the misedit that
// hides something is the NARROW one, and narrow is silent: measured on 3ee1d43, `src/auth` → 2
// executors and `tests/util` → 0 executors, both exited 0 before this mark existed. The counts are
// printed in every outcome, but a count only reports; it cannot refuse, and a floor under it would
// mean writing down a number that rots on the next merge.
// AS IN THE SIBLING GUARD, THE MARK GATES SUCCESS, NOT THE SCAN: an unmarked tree is still walked
// whole and every finding in it is still named by file and line — it just can never exit 0.
// The one cost, named rather than discovered later: this hangs on a filename. Move or rename
// src/server.ts and the guard refuses its own tree — loudly, and in the same commit that breaks
// `npm run build`, which names that exact path, so it cannot drift silently.
import { lstatSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import ts from 'typescript';

const ENTRY = 'server.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Exactly one, not "at least one": a second root would be dropped without a word, so
// `check:executors src src/bin` would have guarded half of what it named and said nothing.
// The empty string is not a root: it resolves to the repo root and walks node_modules. Measured on
// 3ee1d43 with `node scripts/assert-executor-safety.mjs ""`: 49 executors, 1 inspected, among them
// node_modules/zod/src/v4/classic/tests/async-parsing.test.ts:337:29.
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

// SYMLINKED DIRECTORIES ARE FOLLOWED, and a cycle is survived rather than broken. The previous
// claim here — "does not descend into symlinked directories, so a symlink cycle cannot turn this
// into an ELOOP stack trace" — is false, and no runtime is "pinned": package.json allows node
// >=20 and CI runs 20 (.github/workflows/ci.yml:20). Re-measured on node 20.20.2 and 26.5.0 alike,
// on a tree holding one nested-executor file plus `src/sub/loop -> src`:
//   node -e 'console.log(require("node:fs").readdirSync(process.argv[1],{recursive:true}).length)' <tree>
// → 64 entries, including sub/loop, sub/loop/sub, sub/loop/sub/loop. It descends. What saves it is
// not the walk: the OS refuses the open once the symlink chain is too long, and node drops that
// branch silently, so the listing TERMINATES and no ELOOP reaches the caller. The cost is the
// counts, not the findings: the same file is collected once per level, so that tree reports
// 32 executors, 16 inspected for the 2 executors, 1 inspected it holds, and the wedge in it is
// reported 16 times. Nothing is hidden and the exit code is right; the inventory just repeats.
let entries;
try {
  entries = readdirSync(target, { recursive: true });
} catch (err) {
  // A message, not a stack trace, and one sentence for both ways of naming a root that cannot be
  // walked: a missing directory (ENOENT) and a FILE named as the root (ENOTDIR — measured on
  // 3ee1d43: `node scripts/assert-executor-safety.mjs src/server.ts` printed a node:fs source
  // excerpt and a stack trace — 8 frames on node 20, 10 on 26, which is why no count is pinned
  // here). The sibling guard is held to the same bar.
  console.error(`Nothing to inspect: ${target} (${err.code ?? err.message}).`);
  process.exit(1);
}
const files = entries
  .filter((f) => SOURCE.test(f) && !DECLARATION.test(f))
  .sort()
  .map((f) => join(target, f));

const program = ts.createProgram(files, {
  target: ts.ScriptTarget.Latest,
  allowJs: false,
  noLib: true,
  noResolve: true,
});
const checker = program.getTypeChecker();

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

for (const file of files) {
  const source = program.getSourceFile(file);
  if (!source) continue;
  const where = (node) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${relative(root, file)}:${line + 1}:${character + 1}`;
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
          // A settle call is never a foreign call. Stopping the descent into its ARGUMENTS is the
          // narrow part: only inside a settling catch — see the header.
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

const show = relative(root, target) || target;

// THE MARK IS A FILE THIS WALK COLLECTED, not a path that merely exists. `existsSync(join(target,
// ENTRY))` said yes to three things that are not the module the build bundles, each measured on
// 3ee1d43 at exit 0 over an otherwise empty tree: a DIRECTORY named server.ts; a `Server.ts`,
// because existsSync case-folds on darwin — one tree, two verdicts by platform, green locally and
// red on Linux CI, which disqualifies that form on its own; and a server.ts symlinked to a file
// outside the scanned tree. Asking the collected list instead fixes the spelling for free, because
// the entries carry the real on-disk name, and lstat — not stat — refuses the symlink without
// following it. A DANGLING symlink was already refused and still is: lstat succeeds, isFile() is
// false. Costs nothing extra: `files` is built above either way.
const ENTRY_PATH = join(target, ENTRY);
const marked = files.includes(ENTRY_PATH) && lstatSync(ENTRY_PATH).isFile();

// Printed in EVERY outcome, pass or fail: a gate that only speaks when it is happy leaves a red
// build with no record of what was actually looked at. THE STREAM IS KEYED ON THE MARK, NOT ON THE
// EXIT CODE, and that is the whole claim: the inventory of the guarded tree is a true record of what
// was inspected whether the verdict is green or red, while a summary of a tree that was never the
// subject must not sit on stdout reading like one. Keying it on the verdict instead was tried and
// dropped: it merges the inventory into the findings on one stream, where a reader — and three
// assertions in tests/plugin/executor-safety-guard.test.ts that count `file:line:col` occurrences —
// can no longer tell a finding from an inspected-executor entry (measured on 3ee1d43 + this fix:
// the w8 'reports a call chain once' count went from 1 to 3).
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
