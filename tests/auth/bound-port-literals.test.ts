import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// A fixed port on a bind call collides with a concurrent `vitest run` (#23); use freePort().
// This reads source text, so it is evadable by construction. Blind spots, all deliberate:
//   - only the call names listed below are matched;
//   - only a decimal literal written at the call site — a const, a variable, 18e3, 0x4650 or a
//     computed port is not traced, and a call on `70_000 - 52_000` stays green because the
//     first literal is filtered as out of range;
//   - an expression is reported by its first literal, so a call on `17_000 + 1_000` is flagged
//     as 17_000. The file and line are right, the number is not. Requiring the literal to be
//     followed by , or ) would trade that loud wrong number for silence here, and for new
//     misses on a cast such as `18000 as Port`, so the call site keeps winning over the number;
//   - a mention in a comment or a string counts, which is why the samples below are written
//     split — the guard scans its own file. Not a theory: in one review round this reddened the
//     guard three times, twice while this very comment was being written and once in a
//     reviewer's counter-check;
//   - only files directly in tests/auth are scanned, not its subfolders.
// Catching the rest needs a parser or a runtime check, not a wider regex (out of scope, #50).
// Gap in the tests, not in the rule: the scan, the filter and the report format are each pinned,
// but nothing composes them end to end from a real file on disk to a positive finding — that
// needs a probe file, and a probe file cannot live in the directory this guard scans.
const BIND_CALL = /\b(waitForAuthorizationCode|startCallbackListener|listenOn|listen|rebind|config|deps)\(\s*(\d[\d_]*)\b/g;

// 0 is chosen by the OS and anything above 65535 is refused by listen() — neither binds a fixed port.
function isBindablePort(literal: string): boolean {
  const port = Number(literal.replaceAll('_', ''));
  return port >= 1 && port <= 65_535;
}

function scannedFiles(): string[] {
  return readdirSync(HERE).filter((f) => f.endsWith('.ts'));
}

// The source is a parameter so the report format can be pinned without writing a file into the
// directory this guard scans.
function boundPortLiterals(file: string, source = readFileSync(join(HERE, file), 'utf8')): string[] {
  return [...source.matchAll(BIND_CALL)]
    .filter(([, , literal]) => isBindablePort(literal))
    .map((m) => `tests/auth/${file}:${source.slice(0, m.index).split('\n').length} ${m[1]}(${m[2]})`);
}

describe('bound ports in tests/auth', () => {
  it('are acquired, never written as a literal', () => {
    const findings = scannedFiles().flatMap((f) => boundPortLiterals(f));
    expect(findings).toEqual([]);
  });

  // Pins deps(...) in BIND_CALL (#50): the harness binds through deps(port, …), not config(port).
  it('flag a literal port in deps(), but not port 0 or an out-of-range one', () => {
    // 'deps' + '(…' keeps this sample out of the guard's own findings; see the blind spots above.
    const sample = 'deps' + '(18000)\ndeps(0, {})\ndeps(70_000)';
    expect(boundPortLiterals('p.test.ts', sample)).toEqual(['tests/auth/p.test.ts:1 ' + 'deps' + '(18000)']);
  });

  // The scan is the guard's load-bearing part: a narrower filter or a wrong directory silences it
  // without reddening anything. login-harness.ts is where the harness binds and is not a *.test.ts.
  it('scans every .ts directly in tests/auth, helper files included', () => {
    expect(scannedFiles()).toContain('login-harness.ts');
    expect(scannedFiles()).toContain('bound-port-literals.test.ts');
  });

  // Acceptance criterion of #50: the report names file and line, not just that something was found.
  it('reports each finding with its file and its line', () => {
    const sample = '\n\n' + 'deps' + '(18000)';
    expect(boundPortLiterals('probe.test.ts', sample)).toEqual(['tests/auth/probe.test.ts:3 ' + 'deps' + '(18000)']);
  });

  // A separator must not make a port unreadable, a privileged port is still a fixed port, and two
  // calls on one line are two findings.
  it('reads underscored and low literals, and every call on a line', () => {
    const sample = 'deps' + '(20_000); ' + 'deps' + '(80); ' + 'deps' + '(0)';
    expect(boundPortLiterals('p.test.ts', sample)).toEqual([
      'tests/auth/p.test.ts:1 ' + 'deps' + '(20_000)',
      'tests/auth/p.test.ts:1 ' + 'deps' + '(80)',
    ]);
  });
});
