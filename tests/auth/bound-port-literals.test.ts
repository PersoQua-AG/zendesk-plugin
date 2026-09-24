import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// A fixed port on a bind call collides with a concurrent `vitest run` (#23); use freePort().
const BIND_CALL = /\b(waitForAuthorizationCode|startCallbackListener|listenOn|listen|rebind)\(\s*(\d[\d_]*)\b/g;

// 0 is chosen by the OS and anything above 65535 is refused by listen() — neither binds a fixed port.
function isBindablePort(literal: string): boolean {
  const port = Number(literal.replaceAll('_', ''));
  return port >= 1 && port <= 65_535;
}

function boundPortLiterals(file: string): string[] {
  const source = readFileSync(join(HERE, file), 'utf8');
  return [...source.matchAll(BIND_CALL)]
    .filter(([, , literal]) => isBindablePort(literal))
    .map((m) => `tests/auth/${file}:${source.slice(0, m.index).split('\n').length} ${m[1]}(${m[2]})`);
}

describe('bound ports in tests/auth', () => {
  it('are acquired, never written as a literal', () => {
    const findings = readdirSync(HERE)
      .filter((f) => f.endsWith('.ts'))
      .flatMap(boundPortLiterals);
    expect(findings).toEqual([]);
  });
});
