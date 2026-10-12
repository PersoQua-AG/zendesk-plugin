// tests/plugin/retired-mcpb-artifact.test.ts
// Subject: the `.mcpb` bundle left over from the MCPB Desktop Extension path. That path was retired
// in #103 and #118 — `npm run pack` and scripts/audit-bundle.mjs are gone — so such a file is
// residue nothing can rebuild, and it must not reach origin. Nothing else owns that question.
//
// Its own file, the way vitest-run-record.test.ts argues for itself: the packer's own assertions
// lived in tests/plugin/pack-script.test.ts and died with it in #118. This one is not about the
// packer — it is about git refusing the leftover — so it must not share a fate with one again.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitEnv } from '../setup/git-env.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnv() });

describe('the retired MCPB artifact', () => {
  it('is nowhere in the index', () => {
    // Asked of the index rather than of a directory listing: an untracked copy in someone's tree is
    // their business, a tracked one is everyone's. -z, so a path with a newline cannot hide a row.
    const listed = git('ls-files', '-z');
    expect(listed.status, `git ls-files never answered (${listed.error?.message ?? listed.stderr})`).toBe(0);
    const tracked = listed.stdout.split('\0').filter((p) => p.endsWith('.mcpb'));
    expect(tracked, 'a retired-path bundle is tracked; remove it from the index').toEqual([]);
  });

  it('is ignored wherever it lands, asked of git rather than of a parsed .gitignore', () => {
    // Asked of git, not of the text of .gitignore, for the reason measured in
    // vitest-run-record.test.ts on 2026-10-09: an assertion on a literal line pins the spelling, not
    // the property — `*.mcpb` and `**/*.mcpb` ignore the same set and only git says so. Two paths,
    // one at the root and one nested, because a pattern anchored with a leading slash would catch
    // only the first. Neither path need exist; check-ignore answers about the path, not the file.
    // 0 = ignored; 1 = git would offer it for commit; anything else means the question was never
    // asked. Only 0 passes: fail-closed.
    for (const path of ['zendesk.mcpb', 'build/nested/zendesk.mcpb']) {
      const asked = git('check-ignore', '-q', path);
      const why =
        asked.status === 1
          ? 'git would offer it for commit — not ignored'
          : `git check-ignore never answered (${asked.error?.message ?? asked.stderr})`;
      expect(asked.status, `${path}: ${why}`).toBe(0);
    }
  });
});
