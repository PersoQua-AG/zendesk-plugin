import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = join(root, 'scripts', 'assert-executor-safety.mjs');

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The guard takes the directory to inspect as argv[2], so every case below is a real run of the
// real script over a real tree — not an assertion about a string in a file.
function runGuard(source?: string): { status: number; stdout: string; stderr: string } {
  let targetArg: string | undefined;
  if (source !== undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'executor-guard-'));
    temps.push(dir);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'subject.ts'), source);
    targetArg = join(dir, 'src');
  }
  const run = spawnSync('node', targetArg ? [GUARD, targetArg] : [GUARD], { encoding: 'utf8' });
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

// The exact #9 shape: a call that throws synchronously, on the synchronous path of an executor
// nested inside another one, with the inner rejection swallowed.
const WEDGE = `
export function startListener(port: number, server: { listen: (p: number) => void }) {
  return new Promise<void>((bound, bindFailed) => {
    const promise = new Promise<string>((resolve, reject) => {
      server.listen(port);
      bound();
    });
    promise.catch(() => {});
  });
}
`;

describe('promise executor safety guard', () => {
  describe('rejects the defect class', () => {
    it('flags an unguarded foreign call on a nested executor path, with file:line and the call', () => {
      const { status, stderr } = runGuard(WEDGE);
      expect(status).toBe(1);
      expect(stderr).toMatch(/subject\.ts:5:\d+\s+server\.listen\(port\)/);
      expect(stderr).toContain('rejects only the INNER promise');
      // The remedy names the enclosing executor's own reject parameter, not a generic "reject".
      expect(stderr).toContain('bindFailed(err)');
    });

    it('is not satisfied by a bare throw — that rejects the inner promise, which is the bug', () => {
      const { status, stderr } = runGuard(WEDGE.replace('server.listen(port);', `
      try {
        server.listen(port);
      } catch {
        throw new Error('could not bind');
      }`));
      expect(status).toBe(1);
      expect(stderr).toMatch(/server\.listen\(port\)/);
    });

    it('is not satisfied by a catch that settles only the inner executor', () => {
      const { status } = runGuard(WEDGE.replace('server.listen(port);', `
      try {
        server.listen(port);
      } catch (err) {
        reject(err as Error);
      }`));
      expect(status).toBe(1);
    });

    it('does not accept a foreign call sitting in the catch block itself', () => {
      const { status, stderr } = runGuard(WEDGE.replace('server.listen(port);', `
      try {
        bindFailed(new Error('x'));
      } catch (err) {
        server.listen(port);
        bindFailed(err as Error);
      }`));
      expect(status).toBe(1);
      expect(stderr).toMatch(/server\.listen\(port\)/);
    });
  });

  describe('accepts code that cannot wedge', () => {
    it('passes a nested call guarded by a catch that settles the OUTER executor', () => {
      const { status, stdout } = runGuard(WEDGE.replace('server.listen(port);', `
      try {
        server.listen(port);
      } catch (err) {
        bindFailed(err as Error);
      }`));
      expect(status).toBe(0);
      expect(stdout).toContain('nested under 1, inspected');
    });

    it('passes the same call moved out to the top-level executor — a throw there rejects the right promise', () => {
      const { status } = runGuard(`
export function startListener(port: number, server: { listen: (p: number) => void }) {
  return new Promise<void>((bound, bindFailed) => {
    const promise = new Promise<string>((resolve, reject) => { bound(); });
    promise.catch(() => {});
    server.listen(port);
  });
}
`);
      expect(status).toBe(0);
    });

    it('ignores a call inside a callback — it runs after the executor has returned', () => {
      const { status } = runGuard(`
export const f = (server: { on: (e: string, cb: () => void) => void; listen: (p: number) => void }) =>
  new Promise<void>((bound) => {
    const inner = new Promise<void>((resolve) => {
      server.on('listening', () => { server.listen(1); bound(); });
    });
    inner.catch(() => {});
  });
`);
      expect(status).toBe(0);
    });

    it('recognises the executor parameters by their real names, not by "resolve"/"reject"', () => {
      const { status, stdout } = runGuard(WEDGE);
      expect(status).toBe(1);
      expect(stdout).toContain('(bound, bindFailed)');
      expect(stdout).toContain('(resolve, reject)');
    });
  });

  describe('the tree it guards', () => {
    it('passes src/ and reports every executor it found', () => {
      const { status, stdout } = runGuard();
      expect(status).toBe(0);
      expect(stdout).toContain('src/auth/oauth-flow.ts');
      expect(stdout).toContain('src/client/job-poller.ts');
      expect(stdout).toContain('src/client/rate-limiter.ts');
      // The one nested executor in the tree — the site the #9 wedge lived in.
      expect(stdout).toMatch(/src\/auth\/oauth-flow\.ts:\d+:\d+\s+\(resolve, reject\)\s+nested under 1, inspected/);
    });

    it('is wired into npm and into CI, so a violation turns the build red', () => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.scripts['check:executors']).toBe('node scripts/assert-executor-safety.mjs');
      expect(pkg.devDependencies.typescript).toBeDefined(); // the guard's only import; already present
      expect(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')).toContain(
        'npm run check:executors',
      );
    });

    it('adds no dependency of its own', () => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(Object.keys(pkg.dependencies).sort()).toEqual(
        ['@modelcontextprotocol/sdk', 'express', 'express-rate-limit', 'zod'].sort(),
      );
      expect(Object.keys(pkg.devDependencies).sort()).toEqual(
        ['@types/node', '@vitest/coverage-v8', 'typescript', 'vitest'].sort(),
      );
    });
  });
});
