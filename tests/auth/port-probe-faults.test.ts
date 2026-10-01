// #48 follow-up: namedAddressesAreFree() (login-harness.ts:226-238) asks about the three addresses
// Node cannot bind synchronously, and spawnSync reports "the port is taken" and "I could not look"
// through the SAME value — status is 1 on EADDRINUSE and null on a failed fork, on SIGKILL, on
// SIGTERM and on a timeout. Collapsing those into "not free" is the defect these cases pin.
// Measured:
//
//   healthy free port   status 0    signal null
//   EADDRINUSE          status 1    signal null
//   fork ENOENT         status null signal null    error ENOENT
//   child SIGKILLed     status null signal SIGKILL
//   spawn timed out     status null signal SIGTERM error ETIMEDOUT
//
// A failed fork is not rare on a loaded CI box: EAGAIN under the per-user process limit, ENOMEM,
// or an execPath removed under a running suite (fnm/nvm switching the version). freePort() keeps
// the claim on every rejected port (login-harness.ts:219), so "I could not look" costs the whole
// band in one pass.
//
// The faults are injected through process.execPath, which Node leaves writable — the real probe
// runs, unmodified. The first stage of the probe is in-process (wildcardIsFree) and is unaffected;
// these cases reach the child stage behind it. TMPDIR is re-pointed before the harness is imported so the claim
// directory of this file is its own; vitest's default pool runs each test file in its own process
// (vitest.config.ts names no pool), so that env write reaches nobody else.
import { describe, it, expect, beforeEach } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ISOLATED_TMP = mkdtempSync(join(tmpdir(), 'port-probe-faults-'));
process.env.TMPDIR = ISOLATED_TMP;
const CLAIM_DIR = join(ISOLATED_TMP, 'zendesk-plugin-test-ports');

const harness = await import('./login-harness.js');

// Each case gets the whole band back. Without this the first case leaves 10 000 claims behind and
// the next one never reaches a probe at all — it would pass because claimPort() short-circuits,
// which is the test passing for the wrong reason.
beforeEach(() => {
  rmSync(CLAIM_DIR, { recursive: true, force: true });
});

function claimCount(): number {
  try {
    return readdirSync(CLAIM_DIR).length;
  } catch {
    return 0;
  }
}

// Runs `body` with a probe binary that cannot be executed / does not terminate, and always puts the
// real one back — a leaked execPath would redden every later case for the wrong reason.
function withProbeBinary<T>(path: string, body: () => T): T {
  const real = process.execPath;
  process.execPath = path;
  try {
    return body();
  } finally {
    process.execPath = real;
  }
}

function slowProbeBinary(seconds: number): string {
  const path = join(ISOLATED_TMP, `probe-that-hangs-${seconds}.sh`);
  writeFileSync(path, `#!/bin/sh\nexec sleep ${seconds}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('freePort() when the probe itself cannot run', () => {
  it('does not read a failed fork as a busy port', () => {
    const before = claimCount();
    let thrown: Error | undefined;
    withProbeBinary('/nonexistent/node-that-was-removed', () => {
      try {
        harness.freePort();
      } catch (err) {
        thrown = err as Error;
      }
    });
    const burned = claimCount() - before;

    // A probe that never ran says nothing about the port. Burning the band on it turns one
    // transient fork failure into a dead band for every concurrent run of this user: the claims
    // name a LIVE pid, so no sweep takes them back until this process exits.
    expect(burned, `claims consumed by a probe that could not run: ${burned}`).toBeLessThanOrEqual(1);
    expect(
      thrown?.message ?? '(returned a port)',
      'the failure must name the probe, not blame stale claims',
    ).toMatch(/probe|spawn|child|ENOENT/i);
  }, 120_000);

  it('bounds the time one probe may take', () => {
    const SECONDS = 10;
    const started = Date.now();
    withProbeBinary(slowProbeBinary(SECONDS), () => {
      try {
        harness.freePort();
      } catch {
        // Either outcome is fine here; the assertion is about the clock.
      }
    });
    const elapsed = Date.now() - started;

    // spawnSync at login-harness.ts:233 blocks the event loop, so
    // vitest's own test timeout cannot interrupt it. A child that never exits — a probe that
    // inherits NODE_OPTIONS=--inspect-brk does exactly that, measured — hangs the run forever.
    expect(elapsed, `one probe blocked freePort() for ${elapsed} ms`).toBeLessThan(SECONDS * 1000);
  }, 120_000);
});
