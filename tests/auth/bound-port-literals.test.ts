import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// A fixed port on a bind call collides with a concurrent `vitest run` (#23); use freePort().
// Blind spot: only the call names listed below are matched, and only a literal written at the
// call site — a port reaching it through a const or other indirection is not traced.
// Blind spot: only files directly in tests/auth are scanned, not its subfolders.
const BIND_CALL = /\b(waitForAuthorizationCode|startCallbackListener|listenOn|listen|rebind|config|deps)\(\s*(\d[\d_]*)\b/g;

// 0 is chosen by the OS and anything above 65535 is refused by listen() — neither binds a fixed port.
function isBindablePort(literal: string): boolean {
  const port = Number(literal.replaceAll('_', ''));
  return port >= 1 && port <= 65_535;
}

function bindCalls(source: string): RegExpExecArray[] {
  return [...source.matchAll(BIND_CALL)].filter(([, , literal]) => isBindablePort(literal)) as RegExpExecArray[];
}

function boundPortLiterals(file: string): string[] {
  const source = readFileSync(join(HERE, file), 'utf8');
  return bindCalls(source).map(
    (m) => `tests/auth/${file}:${source.slice(0, m.index).split('\n').length} ${m[1]}(${m[2]})`,
  );
}

describe('bound ports in tests/auth', () => {
  it('are acquired, never written as a literal', () => {
    const findings = readdirSync(HERE)
      .filter((f) => f.endsWith('.ts'))
      .flatMap(boundPortLiterals);
    expect(findings).toEqual([]);
  });

  // Pins deps(...) in BIND_CALL (#50): the harness binds through deps(port, …), not config(port).
  it('flag a literal port in deps(), but not port 0 or an out-of-range one', () => {
    // Written split so this file does not trip its own guard; deps is the only call name here.
    const sample = 'deps' + '(18000)\ndeps(0, {})\ndeps(70_000)';
    expect(bindCalls(sample).map((m) => m[2])).toEqual(['18000']);
  });
});
