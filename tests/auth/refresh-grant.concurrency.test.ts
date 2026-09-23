import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { RefreshTokenStore } from '../../src/auth/refresh-token-store.js';

// AC3 says a refresh token is single-use. Inside ONE process that is easy and proves little: the
// spend is synchronous, so nothing can interleave. The claim only carries weight across processes,
// and the only way to measure it is to run real ones. These tests therefore drive dist/ — a child
// `node` has no TypeScript loader — and they fail loudly if dist/ is behind src/ rather than
// quietly measuring yesterday's code.

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_STORE = resolve(HERE, '../../dist/auth/refresh-token-store.js');
// consume() reaches through opaque-token-store and encrypted-file, so a local edit to EITHER would
// otherwise leave this guard silent while the children measured the old mechanism. CI's
// `git diff --exit-code dist/` catches it; a local run would not.
const SRC_FILES = ['refresh-token-store.ts', 'opaque-token-store.ts', 'encrypted-file.ts'].map((f) =>
  resolve(HERE, '../../src/auth', f),
);
const SECRET = 'concurrency-secret-that-is-long-enough';
const WORKERS = 8;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

beforeAll(() => {
  if (!existsSync(DIST_STORE)) {
    throw new Error(`${DIST_STORE} is missing - run \`npm run build\` before the suite (CI builds first).`);
  }
  const built = statSync(DIST_STORE).mtimeMs;
  const stale = SRC_FILES.filter((f) => statSync(f).mtimeMs > built);
  if (stale.length > 0) {
    throw new Error(`dist/ is older than ${stale.join(', ')} - run \`npm run build\`; this test would measure stale code.`);
  }
});

// Each child spins until a shared wall-clock instant, then spends the SAME token. The barrier is
// what makes this a race: without it the children serialise on process startup (tens of ms apart)
// and every one of them would simply observe a cleanly finished predecessor.
const CHILD = `
import { RefreshTokenStore } from ${JSON.stringify(DIST_STORE)};
const [dir, secret, token, startAt] = process.argv.slice(2);
const store = new RefreshTokenStore(dir, secret, 3600000);
while (Date.now() < Number(startAt)) { /* spin to the shared start instant */ }
try {
  process.stdout.write('OK ' + store.consume(token).identity + '\\n');
} catch (e) {
  process.stdout.write('REFUSED ' + (e && e.constructor ? e.constructor.name : 'unknown') + '\\n');
}
`;

interface RaceResult {
  ok: number;
  refused: number;
  lines: string[];
  dir: string;
}

async function race(workers: number): Promise<RaceResult> {
  const dir = mkdtempSync(join(tmpdir(), 'zd-race-'));
  dirs.push(dir);
  const refreshDir = join(dir, 'refresh');
  const token = new RefreshTokenStore(refreshDir, SECRET, 3_600_000).mint('zendesk:777', 'claude.ai');
  const childPath = join(dir, 'child.mjs');
  writeFileSync(childPath, CHILD);

  // Lead time for every child to boot and reach the spin loop before the start instant.
  const startAt = Date.now() + 1_200;
  const lines = await Promise.all(
    Array.from({ length: workers }, () => {
      const child = spawn(process.execPath, [childPath, refreshDir, SECRET, token, String(startAt)], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      return new Promise<string>((res) => {
        let out = '';
        child.stdout.on('data', (c) => (out += String(c)));
        child.on('close', () => res(out.trim()));
      });
    }),
  );
  return {
    ok: lines.filter((l) => l.startsWith('OK')).length,
    refused: lines.filter((l) => l.startsWith('REFUSED')).length,
    lines,
    dir: refreshDir,
  };
}

describe('AC3 — single-use holds across PROCESSES, not just within one', () => {
  it(`${WORKERS} processes spending the same refresh token in the same instant: exactly one wins`, async () => {
    const r = await race(WORKERS);
    // The count is the whole point, so it is reported with its denominator rather than asserted blind.
    // eslint-disable-next-line no-console
    console.log(`cross-process race: ok=${r.ok} refused=${r.refused} of ${r.lines.length} workers`);
    expect(r.ok).toBe(1);
    expect(r.refused).toBe(WORKERS - 1);

    const names = readdirSync(r.dir);
    expect(names.filter((n) => n.endsWith('.enc'))).toHaveLength(0); // the token is spent
    expect(names.filter((n) => n.endsWith('.spent'))).toHaveLength(1); // and provably so, for replay detection
    expect(names.filter((n) => n.endsWith('.claim'))).toHaveLength(0); // the claim is always cleaned up
  }, 30_000);
});
