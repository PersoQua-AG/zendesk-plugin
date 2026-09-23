// scripts/assert-executor-safety.mjs
// Structural guard for the defect class behind #9, not for its instance.
//
// What happened: `server.listen(port)` sat at the end of an INNER promise executor in
// src/auth/oauth-flow.ts. A port outside 0–65535 makes node throw SYNCHRONOUSLY. The throw rejected
// the INNER promise — which hung on a `.catch(() => {})` — while the OUTER promise's resolve/reject
// were never called, so the promise the caller awaited never settled. Login is serialized, so every
// later login hung forever. `server.on('error')` cannot help: a synchronous throw never becomes an
// 'error' event. And 638 tests at 100% coverage on that very file missed it, because v8 counts that
// a statement RAN, not where its exits went.
//
// THE RULE, stated precisely. A synchronous throw inside a promise executor is not dangerous by
// itself: the Promise constructor converts it into a rejection OF THAT PROMISE. It becomes the #9
// wedge only when the promise that absorbs the rejection is not the promise the caller holds — that
// is, when the executor is NESTED on the synchronous path of another executor. So:
//
//   On the synchronous path of a NESTED promise executor, a foreign call must sit inside a try
//   whose catch settles an ENCLOSING executor (calls its resolve or its reject).
//
// A bare `throw` is explicitly NOT enough there: it only rejects the inner promise, which is exactly
// what went wrong. Conversely a foreign call on a TOP-LEVEL executor's synchronous path is never
// reported — its throw already rejects the promise being awaited, and demanding a try/catch around
// it would be ceremony, not safety. That is why `server.listen(port)` is correct where #9 moved it.
//
// Zero new dependencies: `typescript` is already a devDependency, and this is a pure syntax walk
// (ts.createSourceFile — no Program, no type checker), so it needs no build and costs milliseconds.
//
// Deliberate limits, so nobody mistakes this for a proof:
//   - Only synchronous paths. Bodies of nested functions are not descended into: a throw inside
//     `server.on('error', () => …)` runs after the executor returned and cannot wedge it this way.
//     An executor created inside such a callback is treated as a fresh top level.
//   - The allowlist below matches the callee's NAME, not its resolved symbol. A project-defined
//     `on()` that throws would pass. Closing that needs a type checker and a Program; the trade is
//     taken knowingly, because the class that bit us is `listen`-shaped, not `on`-shaped.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Resolved against the repo root, so a relative argument is convenient and an absolute one (the
// tests hand it temp trees) is honoured rather than silently appended to the root.
const target = resolve(root, process.argv[2] ?? 'src');

// Callees that cannot throw on their synchronous path when handed locally-constructed arguments.
// Each entry is a decision a reviewer can overrule; the default is deny, and `listen`, `mkdirSync`,
// `JSON.parse`, `new URL` and every other foreign call stay out of it on purpose.
const ALLOWED_CALLEES = new Map([
  ['setTimeout', 'timer global: throws only on a non-function callback'],
  ['clearTimeout', 'timer global: accepts anything, throws on nothing'],
  ['setInterval', 'timer global: throws only on a non-function callback'],
  ['clearInterval', 'timer global: accepts anything, throws on nothing'],
  ['queueMicrotask', 'throws only on a non-function callback'],
  ['unref', 'Timeout method, no arguments, no failure mode'],
  ['on', 'EventEmitter registration with a function literal — registration cannot throw'],
  ['once', 'EventEmitter registration with a function literal — registration cannot throw'],
  ['then', 'Promise method: schedules the callback, never throws synchronously'],
  ['catch', 'Promise method: schedules the callback, never throws synchronously'],
  ['createServer', 'node http/net: throws only on an invalid options OBJECT, not on a handler fn'],
  ['Promise', 'the Promise constructor turns an executor throw into a rejection; it does not throw'],
]);

const files = [];
(function collect(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) files.push(full);
  }
})(target);

const isFunctionLike = (node) =>
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isClassLike(node);

// Walks only the synchronous path: every nested function is a boundary, not a place to recurse.
function walkSync(node, visit) {
  node.forEachChild((child) => {
    if (isFunctionLike(child)) return;
    visit(child);
    walkSync(child, visit);
  });
}

// Every function-like reached from here, without descending past the first one on each branch.
function eachNestedFunction(node, visit) {
  node.forEachChild((child) => {
    if (isFunctionLike(child)) visit(child);
    else eachNestedFunction(child, visit);
  });
}

const calleeName = (node) => {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isNonNullExpression(callee) || ts.isParenthesizedExpression(callee)) {
    return ts.isIdentifier(callee.expression) ? callee.expression.text : null;
  }
  return null;
};

// `new Promise(fn)` → fn, else null.
const executorOf = (node) => {
  if (!ts.isNewExpression(node)) return null;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'Promise') return null;
  const first = node.arguments?.[0];
  return first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first)) ? first : null;
};

const problems = [];
const inventory = [];

for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const where = (node) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${relative(root, file)}:${line + 1}:${character + 1}`;
  };

  // `ancestors` holds the settle-parameter names of every enclosing executor on the synchronous
  // path. Empty means this executor is a top level and nothing here can be reported.
  function visitExecutor(executor, ancestors) {
    const nameOf = (p) => (p && ts.isIdentifier(p.name) ? p.name.text : null);
    const own = [nameOf(executor.parameters[0]), nameOf(executor.parameters[1])].filter(Boolean);
    inventory.push(
      `${where(executor)}  (${own.join(', ') || '?'})  ${ancestors.length ? `nested under ${ancestors.length}, inspected` : 'top level, not inspected'}`,
    );

    if (ancestors.length > 0) {
      const settlers = new Set(ancestors.flat());
      // Try blocks whose catch settles an enclosing executor. A catch or finally block is NOT
      // inside its own try — a throw there still escapes into the inner promise.
      const safeRanges = [];
      const collect = (node) => {
        if (!ts.isTryStatement(node) || !node.catchClause) return;
        let settles = false;
        const look = (n) => {
          if (ts.isCallExpression(n) && settlers.has(calleeName(n))) settles = true;
        };
        look(node.catchClause.block);
        walkSync(node.catchClause.block, look);
        if (settles) safeRanges.push([node.tryBlock.getStart(), node.tryBlock.getEnd()]);
      };
      collect(executor.body);
      walkSync(executor.body, collect);

      const check = (node) => {
        if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
        const name = calleeName(node);
        if (own.includes(name) || settlers.has(name)) return;
        if (name && ALLOWED_CALLEES.has(name)) return;
        if (safeRanges.some(([from, to]) => node.getStart() >= from && node.getEnd() <= to)) return;
        problems.push({
          at: where(node),
          call: node.getText(source).split('\n')[0].slice(0, 90),
          settler: ancestors[ancestors.length - 1][1] ?? ancestors[ancestors.length - 1][0] ?? 'reject',
        });
      };
      check(executor.body);
      walkSync(executor.body, check);
    }

    // Deeper executors on this synchronous path inherit the chain.
    walkSync(executor.body, (node) => {
      const nested = executorOf(node);
      if (nested) visitExecutor(nested, [...ancestors, own]);
    });
    // Anything created inside a callback runs after this executor returned: fresh top level.
    eachNestedFunction(executor.body, (fn) => findRoots(fn));
  }

  function findRoots(node) {
    node.forEachChild((child) => {
      const executor = executorOf(child);
      if (executor) {
        visitExecutor(executor, []);
        // Still look at the other arguments and the callee, just not at the executor body again.
        child.forEachChild((part) => part !== executor && findRoots(part));
        return;
      }
      findRoots(child);
    });
  }

  findRoots(source);
}

const inspected = inventory.filter((e) => e.endsWith(', inspected')).length;
// Printed in EVERY outcome, pass or fail: a gate that only speaks when it is happy leaves a red
// build with no record of what was actually looked at.
console.log(`Promise executors: ${inventory.length} in ${relative(root, target) || target}/, ${inspected} nested.`);
for (const entry of inventory) console.log(`  - ${entry}`);

if (problems.length > 0) {
  console.error('Refusing the tree: a nested promise executor calls out unguarded.');
  for (const p of problems) {
    console.error(`  - ${p.at}  ${p.call}`);
    console.error(
      '      A synchronous throw here rejects only the INNER promise. The outer one — the one the' +
        ' caller awaits — never settles, and every caller waiting on it hangs (see #9).',
    );
  }
  console.error(
    '\nSettle the OUTER promise, not the inner one:\n' +
      '  try {\n' +
      '    theCall();\n' +
      `  } catch (err) {\n    ${problems[0].settler}(err);   // the enclosing executor's reject — a bare \`throw\` only rejects the inner promise\n  }\n` +
      '\nOr move the call out to the outer executor, where a throw already rejects the right promise.\n' +
      'If the callee genuinely cannot throw, add it to ALLOWED_CALLEES in this script WITH A REASON,\n' +
      'so the exemption is reviewed rather than assumed.',
  );
  process.exit(1);
}

console.log('Every foreign call on a nested executor path is on a settling path.');
