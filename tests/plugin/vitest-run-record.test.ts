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
    // Caught at run time by the assertions below, not by tsc: `defineConfig` types `outputFile` the
    // same with or without the key (measured 2026-10-12).
    const { default: config } = await import('../../vitest.config.js');
    const outputFile = config.test?.outputFile;
    // Narrowed, not cast straight to `{ json: string }`: that cast made a removed key a TypeError
    // from `dirname(undefined)` further down instead of the clear failure this message promises.
    // A string outputFile is the json reporter's path too, so either shape counts.
    const record = typeof outputFile === 'string' ? outputFile : (outputFile as { json?: unknown } | undefined)?.json;
    expect(record, 'vitest.config.ts no longer configures a json outputFile').toBeTypeOf('string');
    // Asked of git, not of the text of .gitignore. Measured on 2026-10-09: an assertion that the
    // literal line `test-results/` appears goes red on a respelling to `/test-results/` and on a
    // record nested one level deeper, both of which git still ignores — it pins the spelling, not
    // the property. 0 = ignored; 1 = git would offer it for commit, including when it is already
    // tracked; anything else means the question was never asked. Only 0 passes: fail-closed.
    const asked = spawnSync('git', ['check-ignore', '-q', record as string], { cwd: root, encoding: 'utf8' });
    // -q prints nothing on exit 1, and a missing git leaves status null: the message has to carry the diagnosis.
    const why =
      asked.status === 1
        ? 'git would offer it for commit — not ignored, or already tracked'
        : `git check-ignore never answered (${asked.error?.message ?? asked.stderr})`;
    expect(asked.status, `${record}: ${why}`).toBe(0);
  });
});
