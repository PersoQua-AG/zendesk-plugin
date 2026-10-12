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
    // A tripwire, not a gate: no edit to .gitignore can turn this red, because an ignore rule never
    // applies to an already-tracked path — which is why the case below cannot answer this question.
    // What it catches is a `git add -f` and a merge from a branch older than the rule. -z, so a path
    // with a newline in it cannot hide a row.
    const listed = git('ls-files', '-z');
    expect(listed.status, `git ls-files never answered (${listed.error?.message ?? listed.stderr})`).toBe(0);
    const tracked = listed.stdout.split('\0').filter((p) => p.endsWith('.mcpb'));
    expect(tracked, 'a retired-path bundle is tracked; remove it from the index').toEqual([]);
  });

  it('is ignored wherever it lands, by a rule that travels, asked of git rather than of a parsed .gitignore', () => {
    // Asked of git, not of the text of .gitignore, for the reason measured in
    // vitest-run-record.test.ts on 2026-10-09.
    //
    // The verdict is `-q` and never `-v`: measured on git 2.55.0 (2026-10-12), `-v` exits 0 on a
    // NEGATED match too, so a `!zendesk-*.mcpb` under the rule would read here as ignored while git
    // went on offering the file. `-v` may name where a rule came from; it may not decide.
    //
    // Two paths, one at the root and one nested under a DIFFERENT name: a rule anchored with a
    // leading slash (`/*.mcpb`) catches only the first, and a rule naming one file (`zendesk.mcpb`)
    // also catches only the first — scripts/audit-bundle.mjs:343 wrote `zendesk-<version>.mcpb`
    // beside `zendesk.mcpb` until #118 removed it, so the second name is residue that really exists.
    // Neither path need exist; check-ignore answers about the path, not about a file.
    //
    // And where the rule comes from is checked, not only its effect: git ignores from
    // .git/info/exclude and core.excludesFile as well, both of which stay on one machine, while the
    // instruction is that this artifact never reaches origin. Only a rule carried by a file in the
    // index reaches another clone.
    for (const path of ['zendesk.mcpb', 'build/nested/zendesk-1.1.0.mcpb']) {
      const verdict = git('check-ignore', '-q', path);
      // -q prints nothing on exit 1, and a missing git leaves status null: the message has to carry
      // the diagnosis. 1 is also the answer for an already-tracked path, rule present or not.
      const why =
        verdict.status === 1
          ? 'git would offer it for commit — not ignored, or already tracked'
          : `git check-ignore never answered (${verdict.error?.message ?? verdict.stderr})`;
      expect(verdict.status, `${path}: ${why}`).toBe(0);
      // `<source>:<line>:<pattern>\t<path>`, so the source is what stands before the last `:<line>:`.
      const shown = git('check-ignore', '-v', path);
      const source = /^(.+):\d+:/.exec(shown.stdout.split('\t')[0] ?? '')?.[1];
      expect(source, `${path}: check-ignore -v named no source (${shown.error?.message ?? shown.stderr})`).toBeTypeOf('string');
      const carrier = git('ls-files', '--error-unmatch', '--', source as string);
      expect(carrier.status, `${path}: ignored by ${source}, which is not in the index — that rule stays on this machine`).toBe(0);
    }
  });
});
