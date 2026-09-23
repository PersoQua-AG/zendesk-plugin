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
// real script over a real tree on disk — not an assertion about a string in a file.
function runGuard(source?: string, fileName = 'subject.ts') {
  let targetArg: string | undefined;
  if (source !== undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'executor-guard-'));
    temps.push(dir);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', fileName), source);
    targetArg = join(dir, 'src');
  }
  const run = spawnSync('node', targetArg ? [GUARD, targetArg] : [GUARD], { encoding: 'utf8' });
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

// w1 — the exact #9 shape: a call that throws synchronously, on the synchronous path of an executor
// nested inside another one, with the inner rejection swallowed by `.catch(() => {})`.
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
  describe('w1 — the defect class it exists for', () => {
    it('flags an unguarded call on a nested executor path, with file:line and the call', () => {
      const { status, stderr } = runGuard(WEDGE);
      expect(status).toBe(1);
      expect(stderr).toMatch(/subject\.ts:5:\d+\s+server\.listen\(port\)/);
      expect(stderr).toContain('rejects only the INNER promise');
      // The remedy names the enclosing executor's own reject parameter, read from the AST.
      expect(stderr).toContain('bindFailed(err)');
    });

    it('still flags it when the parameters carry the idiomatic shadowing names', () => {
      // peer-reviewer, REQUEST-CHANGES: with `resolve, reject` on BOTH executors, a name-based
      // settler set cannot tell the inner reject from the outer one, and the inner `reject(err)`
      // was accepted as settling the outer promise. It settles nothing.
      const shadowed = WEDGE.replace('(bound, bindFailed)', '(resolve, reject)').replace(
        'bound();',
        'resolve();',
      );
      expect(runGuard(shadowed).status).toBe(1);
      const innerOnly = shadowed.replace(
        'server.listen(port);',
        'try { server.listen(port); } catch (err) { reject(err as Error); }',
      );
      const run = runGuard(innerOnly);
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/server\.listen\(port\)/);
    });

    it('is not satisfied by a bare throw — that rejects the inner promise, which is the bug', () => {
      const { status } = runGuard(
        WEDGE.replace(
          'server.listen(port);',
          `try { server.listen(port); } catch { throw new Error('could not bind'); }`,
        ),
      );
      expect(status).toBe(1);
    });

    it('does not accept a foreign call sitting in the catch block itself', () => {
      const { status, stderr } = runGuard(
        WEDGE.replace(
          'server.listen(port);',
          `try { bindFailed(new Error('x')); } catch (err) { server.listen(port); bindFailed(err as Error); }`,
        ),
      );
      expect(status).toBe(1);
      expect(stderr).toMatch(/server\.listen\(port\)/);
    });

    it('passes a nested call guarded by a catch that settles the OUTER executor', () => {
      const { status, stdout } = runGuard(
        WEDGE.replace(
          'server.listen(port);',
          `try { server.listen(port); } catch (err) { bindFailed(err as Error); }`,
        ),
      );
      expect(status).toBe(0);
      expect(stdout).toContain('nested, inspected');
    });

    it('passes the call moved out to a sync top level — a throw there rejects the right promise', () => {
      expect(
        runGuard(`
export function startListener(port: number, server: { listen: (p: number) => void }) {
  return new Promise<void>((bound, bindFailed) => {
    const promise = new Promise<string>((resolve) => { bound(); });
    promise.catch(() => {});
    server.listen(port);
  });
}
`).status,
      ).toBe(0);
    });
  });

  // BLOCKER from the fix loop: an async executor's synchronous throw lands in the async function's
  // discarded return promise. The outer promise never settles AND the process does not crash —
  // the #9 symptom exactly, with no nesting involved.
  describe('w1b — async executors', () => {
    const ASYNC_WEDGE = `
export const start = (port: number, server: { listen: (p: number) => void }) =>
  new Promise<void>(async (bound, bindFailed) => {
    server.listen(port);
    bound();
  });
`;
    it('inspects an async TOP-LEVEL executor and flags the unguarded call', () => {
      const { status, stderr, stdout } = runGuard(ASYNC_WEDGE);
      expect(status).toBe(1);
      expect(stderr).toMatch(/server\.listen\(port\)/);
      expect(stdout).toMatch(/async, inspected/);
    });

    it('accepts the async executor once its own reject settles the promise', () => {
      expect(
        runGuard(
          ASYNC_WEDGE.replace(
            'server.listen(port);',
            `try { server.listen(port); } catch (err) { bindFailed(err as Error); }`,
          ),
        ).status,
      ).toBe(0);
    });

    it('is not satisfied by a bare throw in an async executor either', () => {
      expect(
        runGuard(
          ASYNC_WEDGE.replace(
            'server.listen(port);',
            `try { server.listen(port); } catch { throw new Error('nope'); }`,
          ),
        ).status,
      ).toBe(1);
    });
  });

  describe('w2 — the executor reached through a variable', () => {
    it('follows an identifier to its arrow function', () => {
      const { status, stderr } = runGuard(`
const exec = (resolve: (v: void) => void, reject: (e: Error) => void) => {
  (globalThis as unknown as { boom: () => void }).boom();
  resolve();
};
export const f = () =>
  new Promise<void>((bound, bindFailed) => {
    const inner = new Promise<void>(exec);
    inner.catch(() => {});
    bound();
  });
`);
      expect(status).toBe(1);
      expect(stderr).toMatch(/subject\.ts:3:\d+/);
    });

    it('follows an identifier to a function declaration', () => {
      const { status } = runGuard(`
function exec(resolve: (v: void) => void) {
  (globalThis as unknown as { boom: () => void }).boom();
  resolve();
}
export const f = () =>
  new Promise<void>((bound) => {
    const inner = new Promise<void>(exec);
    inner.catch(() => {});
    bound();
  });
`);
      expect(status).toBe(1);
    });
  });

  describe('w4/w5 — bindings, not names', () => {
    it('does not exempt a locally declared function that shares a global name', () => {
      // `createServer` used to sit on an allowlist keyed by NAME; a local one inherited the pass.
      const { status, stderr } = runGuard(`
function createServer(_h: () => void) { return { listen: (_p: number) => {} }; }
export const f = () =>
  new Promise<void>((bound, bindFailed) => {
    const inner = new Promise<void>((resolve) => {
      createServer(() => {});
      resolve();
    });
    inner.catch(() => {});
    bound();
  });
`);
      expect(status).toBe(1);
      expect(stderr).toMatch(/createServer/);
    });

    it('does not treat a method call as settling just because it is named resolve', () => {
      const { status } = runGuard(`
export const f = (router: { resolve: (p: string) => string }) =>
  new Promise<void>((resolve, reject) => {
    const inner = new Promise<void>((res) => {
      try {
        (globalThis as unknown as { boom: () => void }).boom();
      } catch {
        router.resolve('/x');
      }
      res();
    });
    inner.catch(() => {});
    resolve();
  });
`);
      expect(status).toBe(1);
    });
  });

  describe('w7 — the catch must settle unconditionally', () => {
    it('rejects a settle that hides behind a condition', () => {
      const { status } = runGuard(
        WEDGE.replace(
          'server.listen(port);',
          // The condition is deliberately call-free: the ONLY thing separating this from the
          // accepted form is that the settle is conditional, so the test cannot pass by accident.
          `try { server.listen(port); } catch (err) { if (port > 0) bindFailed(err as Error); }`,
        ),
      );
      expect(status).toBe(1);
    });
  });

  describe('w8 — one finding per chained expression', () => {
    it('reports a call chain once, not once per link', () => {
      const { stderr, status } = runGuard(`
export const f = (items: string[]) =>
  new Promise<void>((bound, bindFailed) => {
    const inner = new Promise<void>((resolve) => {
      const s = items.map((i) => i).filter((i) => i.length > 0).join(',');
      resolve();
    });
    inner.catch(() => {});
    bound();
  });
`);
      expect(status).toBe(1);
      expect(stderr.match(/subject\.ts:\d+:\d+/g)).toHaveLength(1);
      expect(stderr).toContain('.join(');
    });
  });

  describe('w9 — the remediation hint must not propose a second defect', () => {
    it('does not tell the author to resolve the outer promise with an Error', () => {
      const { status, stderr } = runGuard(`
export const f = (port: number, server: { listen: (p: number) => void }) =>
  new Promise<void>((bound) => {
    const inner = new Promise<void>((resolve) => {
      server.listen(port);
      resolve();
    });
    inner.catch(() => {});
  });
`);
      expect(status).toBe(1);
      expect(stderr).not.toMatch(/bound\(err\)/);
      expect(stderr).toContain('declares no reject parameter');
    });
  });

  describe('documented limits — named so the next reader does not think they were checked', () => {
    it('does not see `new P(...)` through a Promise alias, and says so in its header', () => {
      expect(
        runGuard(`
const P = Promise;
export const f = (server: { listen: (p: number) => void }) =>
  new P((bound: (v: void) => void) => {
    const inner = new P((resolve: (v: void) => void) => { server.listen(1); resolve(); });
    (inner as Promise<void>).catch(() => {});
    bound();
  });
`).status,
      ).toBe(0);
      expect(readFileSync(GUARD, 'utf8')).toContain('Aliased through a variable');
    });

    it('does not follow calls into callbacks, and the header names BOTH real outcomes', () => {
      // w3: a throw inside a .then callback wedges the outer promise silently — same class, not
      // caught here. A throw inside a setTimeout/emitter callback instead kills the process as an
      // uncaughtException; src/auth/oauth-flow.ts documents that very incident.
      expect(
        runGuard(`
export const f = () =>
  new Promise<void>((bound) => {
    Promise.resolve().then(() => {
      (globalThis as unknown as { boom: () => void }).boom();
      bound();
    });
  });
`).status,
      ).toBe(0);
      const header = readFileSync(GUARD, 'utf8');
      expect(header).toContain('uncaughtException');
      expect(header).toContain('wedges the outer promise silently');
    });
  });

  describe('file collection', () => {
    it('inspects .tsx, .mts and .cts, and skips declaration files', () => {
      for (const name of ['subject.tsx', 'subject.mts', 'subject.cts']) {
        expect(runGuard(WEDGE, name).status, name).toBe(1);
      }
      expect(runGuard(WEDGE, 'subject.d.ts').status).toBe(0);
    });
  });

  describe('the tree it guards', () => {
    it('passes src/ and reports every executor it found, with its real parameter names', () => {
      const { status, stdout } = runGuard();
      expect(status).toBe(0);
      expect(stdout).toContain('src/auth/oauth-flow.ts');
      expect(stdout).toContain('src/client/job-poller.ts');
      expect(stdout).toContain('src/client/rate-limiter.ts');
      expect(stdout).toContain('(bound, bindFailed)');
      expect(stdout).toMatch(
        /src\/auth\/oauth-flow\.ts:\d+:\d+\s+\(resolve, reject\)\s+nested, inspected/,
      );
    });

    it('lists each executor exactly once, however deep the nesting', () => {
      const { stdout } = runGuard(`
export const f = () =>
  new Promise<void>((a1, r1) => {
    const p2 = new Promise<void>((a2, r2) => {
      const p3 = new Promise<void>((a3, r3) => {
        try { (globalThis as unknown as { boom: () => void }).boom(); } catch (e) { r1(e as Error); }
        a3();
      });
      p3.catch(() => {});
      a2();
    });
    p2.catch(() => {});
    a1();
  });
`);
      expect(stdout.match(/subject\.ts:\d+:\d+/g)).toHaveLength(3);
      expect(stdout).toContain('3 executors, 2 inspected');
    });

    it('is wired into npm and into CI, so a violation turns the build red', () => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      expect(pkg.scripts['check:executors']).toBe('node scripts/assert-executor-safety.mjs');
      expect(pkg.devDependencies.typescript).toBeDefined(); // the guard's only import, already there
      expect(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')).toContain(
        'npm run check:executors',
      );
    });
  });
});
