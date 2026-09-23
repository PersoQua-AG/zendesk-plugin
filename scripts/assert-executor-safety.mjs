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
//   - The settle call itself is exempt, its ARGUMENTS are not: `reject(new Error(String(err)))` in a
//     catch is reported, because a throw while building that argument escapes just the same. Keep
//     the catch to a settle of something already in hand.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Resolved against the repo root, so a relative argument is convenient and an absolute one (the
// tests hand it temp trees) is honoured rather than silently appended to the root.
const target = resolvePath(root, process.argv[2] ?? 'src');

const SOURCE = /\.(ts|tsx|mts|cts)$/;
const DECLARATION = /\.d\.(ts|mts|cts)$/;
// node's own recursive walk (>=20, pinned in package.json) does not descend into symlinked
// directories, so a symlink cycle cannot turn this into an ELOOP stack trace.
const files = readdirSync(target, { recursive: true })
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

// Walks only the synchronous path: every function is a boundary, not a place to recurse.
function walkSync(node, visit) {
  node.forEachChild((child) => {
    if (isFunctionBoundary(child)) return;
    visit(child);
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
        if (settles) safeRanges.push([node.tryBlock.getStart(), node.tryBlock.getEnd()]);
      };
      collect(executor.body);
      walkSync(executor.body, collect);

      const found = [];
      const check = (node) => {
        if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
        // A nested `new Promise(fn)` is inspected in its own right, not counted as a foreign call.
        if (executorOf(node)) return;
        const settler = calleeSymbol(node);
        if (settler && (settlers.has(settler) || ownSymbols.has(settler))) return;
        if (safeRanges.some(([from, to]) => node.getStart() >= from && node.getEnd() <= to)) return;
        found.push(node);
      };
      check(executor.body);
      walkSync(executor.body, check);

      // One finding per expression: `a.map(x).filter(y).join(z)` is three CallExpressions nested in
      // one another, and reporting the outermost says everything the inner two would.
      const settleName = (nested ? ancestors[ancestors.length - 1] : own).rejectName;
      for (const node of found) {
        const enclosed = found.some(
          (other) =>
            other !== node && other.getStart() <= node.getStart() && other.getEnd() >= node.getEnd(),
        );
        if (enclosed) continue;
        problems.push({
          at: where(node),
          call: node.getText(source).replace(/\s+/g, ' ').slice(0, 90),
          nested,
          settleName,
        });
      }
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

// Printed in EVERY outcome, pass or fail: a gate that only speaks when it is happy leaves a red
// build with no record of what was actually looked at.
console.log(
  `Promise executors in ${relative(root, target) || target}/: ${inventory.length} executors, ${inspectedCount} inspected.`,
);
for (const entry of inventory) console.log(`  - ${entry}`);

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
    'Wrapping the whole executor body in one try with a settling catch answers every call at once.\n' +
      'There is no per-call exemption on purpose: the calls nobody thought of are the ones that bite.',
  );
  process.exit(1);
}

console.log('Every call on an inspected executor path is on a settling path.');
