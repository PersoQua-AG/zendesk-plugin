// tests/plugin/vitest-run-record.test.ts
// Subject: the footprint vitest.config.ts leaves in the working tree. The config makes every
// `npm test` write a machine-readable run record so a failing run is classifiable without
// scroll-back (#51); that record is a new on-disk sink for failure text, test sentinels included,
// so it must not be committable. Nothing else owns that question.
//
// Its own file rather than a corner of another suite, the way security-level-claims.test.ts argues
// for itself in its header: this assertion arrived in tests/plugin/pack-script.test.ts, whose subject was
// the MCPB packer retired in #118. It was never about the packer — it keeps the record out of git,
// not out of the bundle — and it would have died with a neighbour it was not related to.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the run record vitest.config.ts writes', () => {
  it('is kept out of git, asked of git rather than of a parsed .gitignore', async () => {
    // THE PATH IS READ OUT OF THE CONFIG, not retyped: the config is importable — tests/tsconfig.json
    // already includes it — so this test asks about the path the reporter ACTUALLY writes, where a
    // retyped literal would keep matching nothing while the reporter wrote somewhere else.
    //
    // It is caught at RUN TIME, not by the type checker, and the difference is worth stating because
    // an earlier version of this comment claimed the opposite. Measured 2026-10-12: delete the
    // `outputFile` line, or empty it to `{}`, and `tsc -p tests/tsconfig.json` exits 0 with no
    // diagnostic either way — the `as { json?: unknown }` below is what erases it. What does fire is
    // the next assertion, naming the key that went missing. That is the guarantee; the type checker
    // is not part of it.
    const { default: config } = await import('../../vitest.config.js');
    const outputFile = config.test?.outputFile;
    // Narrowed through these two assertions, not cast straight to `{ json: string }`: that cast made
    // a removed key a TypeError from `dirname(undefined)` further down instead of the clear failure
    // these messages promise. Measured: removing the key fails here with "no longer configures an
    // outputFile: expected undefined to be type of 'object'".
    expect(outputFile, 'vitest.config.ts no longer configures an outputFile').toBeTypeOf('object');
    const record = (outputFile as { json?: unknown }).json;
    expect(record, 'vitest.config.ts no longer configures a json outputFile').toBeTypeOf('string');
    // Asked of git, not of the text of .gitignore. Measured on 2026-10-09: an assertion that the
    // literal line `test-results/` appears goes red on a respelling to `/test-results/` and on a
    // record nested one level deeper, both of which git still ignores — it pins the spelling, not
    // the property. 0 = ignored; 1 = git would offer it for commit, including when it is already
    // tracked; anything else means the question was never asked. Only 0 passes: fail-closed.
    const asked = spawnSync('git', ['check-ignore', '-q', record as string], { cwd: root, encoding: 'utf8' });
    // The message carries the diagnosis, because `-q` prints NOTHING on the branch that fires: exit
    // 1 is "not ignored" with no output at all, and a missing git gives status null with stderr
    // undefined, so interpolating stderr alone said "exited 1: " and "exited null: undefined".
    const why =
      asked.status === 1
        ? 'git would offer it for commit — no ignore rule covers it'
        : `git check-ignore never answered (${asked.error?.message ?? asked.stderr ?? 'no output'})`;
    expect(asked.status, `${record}: ${why}`).toBe(0);
  });
});
