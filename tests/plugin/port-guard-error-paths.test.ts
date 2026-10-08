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
// readFileSync is patched by path, not wholesale: the module loader reads the guard's own source
// through it, so a blanket throw kills the process before the guard starts.
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

// Written split, as in the sibling suite: this file sits inside the scanned tree, so the marker
// spelled whole would make tests/plugin read as a tree that owns the port allocator.
const ACQUIRES = `export function ${'freePort'}(): number { return 0; }\n`;

// The preload lives outside the scanned tree on purpose: `.cjs` matches the guard's source filter,
// so a preload dropped next to the fixtures would be scanned as one of them.
function preload(body: string): string {
  const file = join(tempDir('port-guard-preload-'), 'throw-null.cjs');
  writeFileSync(file, body);
  return file;
}

function runGuard(pre: string, target: string) {
  const run = spawnSync('node', ['-r', pre, GUARD, target], { encoding: 'utf8' });
  if (run.error) throw run.error;
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

// The shape the seven siblings use since #77 (#94: one rule, one spelling) rather than a frame
// count or a named fs call — a leak is a node-internal frame on these paths.
const noStackFrame = (stderr: string) => expect(stderr).not.toMatch(/^\s+at .*\(node:/m);

describe('#110 — the port guard’s error paths survive a throw that is not an Error', () => {
  it('names an unlistable root without a stack trace when the throw is null', () => {
    const pre = preload('require("fs").readdirSync = () => { throw null; };\n');
    const run = runGuard(pre, tempDir('port-guard-tree-'));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Cannot scan');
    expect(run.stderr).toContain('null');
    expect(run.stderr).not.toContain('TypeError');
    noStackFrame(run.stderr);
  });

  it('names an unreadable file without a stack trace when the throw is null', () => {
    const dir = tempDir('port-guard-tree-');
    writeFileSync(join(dir, 'ok.ts'), ACQUIRES);
    writeFileSync(join(dir, 'throws-null.ts'), 'const x = 1;\n');
    // By path, and the `EISDIR` comparison above the message is on the same throw: it read
    // `err.code` first, so this case was red at that line before the message line was reached.
    const pre = preload(
      [
        'const fs = require("fs");',
        'const real = fs.readFileSync;',
        'fs.readFileSync = function (p, ...rest) {',
        '  if (String(p).includes("throws-null")) throw null;',
        '  return real.call(fs, p, ...rest);',
        '};',
        '',
      ].join('\n'),
    );
    const run = runGuard(pre, dir);
    // 2, not 1: "could not look" must not be spelled like "looked and found".
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Cannot read');
    expect(run.stderr).toContain('null');
    expect(run.stderr).not.toContain('TypeError');
    noStackFrame(run.stderr);
  });
});
