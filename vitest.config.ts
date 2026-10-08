import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // A suite that can reach the internet does not fail, it lies: three of the two-step login cases
    // run without an `exchange` stub, and on a regression they would POST to the real
    // acme.zendesk.com instead of turning red. The guard rejects every non-loopback fetch.
    // no-fixed-bind-port is the runtime half of #23: the source scan in
    // scripts/assert-no-bound-port-literals.mjs cannot see a port that reaches listen() through a
    // const or an expression, and this refuses it at the bind instead of at the spelling.
    setupFiles: ['tests/setup/no-network.ts', 'tests/setup/no-fixed-bind-port.ts'],
    // #51. A failing run used to leave its evidence in scroll-back only: a QA round lost the names
    // of two failing tests to a terminal buffer and had to write the occurrence off as "load",
    // unevidenced. The default reporter still prints; this one additionally leaves the file and the
    // full name of every test behind, so the next occurrence can be classified instead of guessed
    // at. It is in the config rather than in a CI flag so that a local run, a QA worktree and CI
    // all produce it without anybody having to remember a flag. Read the failures back with:
    //   node -e "for (const f of require('./test-results/vitest-<pid>.json').testResults)
    //     for (const t of f.assertionResults) if (t.status === 'failed') console.log(f.name, t.fullName)"
    //
    // The pid is in the NAME because two overlapping runs — a QA worktree beside a local watch, or
    // two CI jobs on one checkout — otherwise overwrite each other's evidence, which is the one
    // thing this file exists to preserve. The directory is what .gitignore and .mcpbignore carry,
    // so the name can vary freely.
    //
    // TWO THINGS THIS DOES NOT DO, said rather than left to be discovered. Nothing prunes the
    // directory, and an INTERRUPTED run leaves a record shaped exactly like a complete one — so a
    // short file is not evidence of a short run. And the record is a new on-disk sink for failure
    // text, test sentinels included; the two ignore files keep it out of git and out of the bundle,
    // and the audit's default-deny would refuse it even if they did not, but
    // `expectNoSecretEchoed` guards the two streams and not this file.
    reporters: ['default', 'json'],
    outputFile: { json: `test-results/vitest-${process.pid}.json` },
    // Runs once, after every file: the only place that can see what a SPAWNED child did to the machine.
    // A suite that creates a real Keychain item fails the run there — see the file for why it compares
    // before with after instead of demanding an empty keychain.
    globalSetup: ['tests/setup/no-real-keychain.ts'],
    coverage: {
      provider: 'v8',
      // Every shipped source file counts, not just the ones a test happened to import — otherwise a
      // new untested module would raise the percentage by staying invisible.
      all: true,
      include: ['src/**/*.ts'],
      // dist/ is the compiled copy of src/ (it would count every file twice), tests/ and scripts/
      // are the measuring apparatus, and a .d.ts carries no executable code at all.
      exclude: ['dist/**', 'tests/**', 'scripts/**', '*.config.ts', 'src/**/*.d.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        // Set from the measured state, not from a wish: measured on this branch on 2026-10-08 the
        // suite stands at 98.84% statements / 93.49% branches / 98.37% functions / 98.84% lines (it
        // was 97.98/88.50/97.10/97.98 when these floors were written). The floors are absolute
        // minima, not a ratchet: they catch a collapse, not a regression — today the headroom above
        // them is 6.49 points on branches, 2.37 on functions and 1.84 on statements and lines, and
        // any drop inside that band ships green. They stay far above the 80% project minimum, which
        // as a floor here would license a slow decay down to it.
        statements: 97,
        branches: 87,
        functions: 96,
        lines: 97,
        // Business-critical: the OAuth path a Desktop user logs in through. Every line and every
        // branch of it is exercised today, and nothing may ship there on an untested path.
        'src/auth/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/tools/login.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
