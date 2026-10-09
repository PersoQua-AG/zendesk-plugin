// tests/plugin/port-guard-error-paths.test.ts
// #110. The subject here is the ERROR HANDLING of scripts/assert-no-bound-port-literals.mjs, not
// its literal scan: both catch blocks read `err.code` on a value that need not be an Error, and on
// a thrown `null` that read raised `TypeError: Cannot read properties of null` — the stack trace
// the two catch blocks exist to prevent.
//
// Its own file rather than an extension of bound-port-literals-guard.test.ts: that suite is scoped
// to the scan and the guarded tree, and it is held open by PR #109 for the duration of this change,
// so adding a second subject to it would collide. tests/plugin/security-level-claims.test.ts:7-11
// records the same split for the same reason.
//
// Real runs of the real script over a throwaway tree, like every case in the sibling suite. The one
// thing a tree cannot supply is a non-Error throw, because node:fs never produces one. A CJS `-r`
// preload replaces the fs function with one that throws `null`; the ESM facade of `node:fs` is
// instantiated after the preload, so the guard's own named imports see the replacement (measured on
// node 20.20.2, 22.21.1 and 26.5.0 — and on all three the unfixed guard printed the TypeError).
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = join(root, 'scripts', 'assert-no-bound-port-literals.mjs');

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

// The preload lives outside the scanned tree on purpose: `.cjs` matches the guard's source filter,
// so a preload dropped next to the fixtures would be scanned as one of them.
function preload(body: string): string {
  const file = join(tempDir('port-guard-preload-'), 'throw-null.cjs');
  writeFileSync(file, body);
  return file;
}

function runGuard(pre: string, target: string) {
  const run = spawnSync('node', ['-r', pre, GUARD, target], { encoding: 'utf8' });
  // Rethrown rather than folded into a status: `status ?? -1` would turn "node never started" into
  // a non-zero that satisfies the exit-code assertions below.
  if (run.error) throw run.error;
  return run;
}

describe('#110 — the port guard’s error paths survive a throw that is not an Error', () => {
  it('names an unlistable root without a stack trace when the throw is null', () => {
    const pre = preload('require("fs").readdirSync = () => { throw null; };\n');
    const run = runGuard(pre, tempDir('port-guard-tree-'));
    // THE SUBSTRING IS WHAT SEPARATES THIS, NOT THE CODE. Exit 1 is also "a fixed port was found"
    // and "not the guarded tree", and an empty fixture would reach the second of those; only
    // `Cannot scan` says the listing itself refused. The code is asserted as well so that a run
    // which prints the message and then carries on does not pass.
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Cannot scan');
    // The thrown value itself, not a bare `null` the temp path could also supply.
    expect(run.stderr).toContain(': null.');
    expect(run.stderr).not.toContain('TypeError');
    expect(run.stderr).not.toMatch(/^\s+at .*\(node:/m);
  });

  it('names an unreadable file without a stack trace when the throw is null', () => {
    const dir = tempDir('port-guard-tree-');
    writeFileSync(join(dir, 'ok.ts'), 'const ok = 1;\n');
    // NEITHER FIXTURE NAME MAY CARRY A SUBSTRING THIS CASE ASSERTS. `unreadable.ts`, because the
    // message is `Cannot read <path>: <value>`: a fixture called throws-null.ts satisfied
    // `toContain('null')` out of the PATH, so the printed value went unread and a mutant that
    // dropped only this line's `?? err` printed `undefined` and stayed green. Measured.
    writeFileSync(join(dir, 'unreadable.ts'), 'const x = 1;\n');
    // Patched by path, not wholesale: the module loader reads the guard's own source through
    // readFileSync, so a blanket throw kills the process before the guard starts.
    const pre = preload(`const fs = require("fs");
const real = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
  if (String(p).includes("unreadable")) throw null;
  return real.call(fs, p, ...rest);
};
`);
    const run = runGuard(pre, dir);
    // 2, not 1: "could not look" must not be spelled like "looked and found". No fixture defines
    // freePort(), so the mark is out of reach here anyway — the abort at the read happens before
    // the mark is computed. Control run, measured on this fixture without the preload: exit 1 with
    // `Not the guarded tree`, which fails `toBe(2)` loudly, so a preload that silently stopped
    // working cannot leave this case green.
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Cannot read');
    // The thrown value itself, which only this line's third fallback can print.
    expect(run.stderr).toContain(': null.');
    expect(run.stderr).not.toContain('TypeError');
    // The shape the seven siblings use since #77 (#94: one rule, one spelling) rather than a frame
    // count or a named fs call — a leak on these paths does carry a node-internal frame.
    expect(run.stderr).not.toMatch(/^\s+at .*\(node:/m);
  });
});
