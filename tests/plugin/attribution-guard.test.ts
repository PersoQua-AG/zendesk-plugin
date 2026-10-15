import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitEnv } from '../setup/git-env.js';
import { bare, ciJobSteps, ciSteps, ciTriggers, ciUses } from '../setup/ci-steps.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = join(root, 'scripts', 'assert-no-attribution.mjs');

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Run = { status: number; stdout: string; stderr: string };

const run = (args: string[], { input, cwd = root, guard = GUARD }: { input?: string; cwd?: string; guard?: string } = {}): Run => {
  const r = spawnSync('node', [guard, ...args], { encoding: 'utf8', input, cwd, env: gitEnv() });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
};

// A real repository with real commits, because the guard reads commit bodies through git. Asserting
// against a string in a file would not notice the day `git log --format` stops producing records.
const isolated = () => ({ ...gitEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
const gitIn = (dir: string, ...args: string[]) =>
  spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: isolated() }).stdout.trim();

function repoWith(bodies: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-guard-'));
  temps.push(dir);
  const git = (...args: string[]) => gitIn(dir, ...args);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(join(dir, 'f'), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  bodies.forEach((body, i) => {
    writeFileSync(join(dir, 'f'), `change ${i}\n`);
    git('add', '.');
    git('commit', '-q', '-m', body);
  });
  return dir;
}

// GitHub substitutes `${{ expr }}` before the shell starts; what the event does not carry is ''.
// A context path only, by contract: an operator such as `|| ''` is not evaluated and reads as ''.
const expand = (text: string, ctx: Record<string, string>) =>
  text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, e: string) => ctx[e] ?? '');
const expandAll = (env: Record<string, unknown> | undefined, ctx: Record<string, string>) =>
  Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, expand(String(v), ctx)]));

const inRepo = (dir: string, args: string[]): Run => run(args, { cwd: dir });

function mutate(edits: Array<[string, string]>): string {
  let code = readFileSync(GUARD, 'utf8');
  for (const [find, replace] of edits) {
    expect(code, `mutation anchor missing: ${find.slice(0, 50)}`).toContain(find);
    code = code.replace(find, replace);
  }
  // Into a temp directory, not the real scripts/: a crashed run used to leave `.mutant-attr-*.mjs`
  // sitting in the work tree. This guard imports nothing but node builtins, so it runs anywhere.
  const dir = mkdtempSync(join(tmpdir(), 'attribution-mutant-'));
  temps.push(dir);
  const path = join(dir, 'mutant.mjs');
  writeFileSync(path, code);
  return path;
}

const TRAILER = 'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>';
// The prose form that must survive: this repository really has one, c314138, and a guard that
// cannot tell a violation from a correct explanation of it teaches people to stop explaining.
const PROSE =
  'fix: copy rather than merge\n\nThe branch could not be merged: its first commit carries a Claude\nattribution trailer that the team forbids, so the work was copied.\n';

describe('no-Claude-attribution guard (#86)', () => {
  describe('what it matches', () => {
    it('fails a commit whose body carries the Co-Authored-By trailer, and names the commit', () => {
      const dir = repoWith([`feat: a thing\n\nBody.\n\n${TRAILER}\n`]);
      const r = inRepo(dir, ['--range', 'HEAD~1..HEAD']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Co-Authored-By trailer naming Claude');
      expect(r.stderr).toContain('feat: a thing');
      expect(r.stderr).toContain(TRAILER);
    });

    it('fails a Claude-Session trailer', () => {
      const dir = repoWith(['feat: b\n\nClaude-Session: 0a1b2c3d\n']);
      expect(inRepo(dir, ['--range', 'HEAD~1..HEAD']).status).toBe(1);
    });

    it('fails the Claude Code generated-with sign-off', () => {
      const dir = repoWith(['feat: c\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n']);
      const r = inRepo(dir, ['--range', 'HEAD~1..HEAD']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('generated-with sign-off');
    });

    it('fails a Co-Authored-By naming only the anthropic.com address', () => {
      const dir = repoWith(['feat: d\n\nCo-Authored-By: Someone <noreply@anthropic.com>\n']);
      expect(inRepo(dir, ['--range', 'HEAD~1..HEAD']).status).toBe(1);
    });

    it('passes a commit that cites the rule in prose without attributing authorship', () => {
      const dir = repoWith([PROSE]);
      const r = inRepo(dir, ['--range', 'HEAD~1..HEAD']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('No Claude attribution');
    });

    it('passes a human co-author', () => {
      const dir = repoWith(['feat: e\n\nCo-Authored-By: René Simon Pfisterer <r.pfisterer@persoqua.de>\n']);
      expect(inRepo(dir, ['--range', 'HEAD~1..HEAD']).status).toBe(0);
    });

    it('names every offending commit in a range, not just the first', () => {
      const dir = repoWith([`feat: one\n\n${TRAILER}\n`, 'feat: clean\n', `feat: two\n\n${TRAILER}\n`]);
      const r = inRepo(dir, ['--range', 'HEAD~3..HEAD']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('2 Claude attribution(s)');
      expect(r.stderr).toContain('feat: one');
      expect(r.stderr).toContain('feat: two');
    });
  });

  describe('pull request descriptions', () => {
    it('fails a description carrying the generated-with sign-off', () => {
      const r = run(['--stdin', 'the pull request description'], { input: 'Summary.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('the pull request description');
    });

    it('passes a description that merely discusses the rule', () => {
      expect(run(['--stdin', 'the pull request description'], { input: PROSE }).status).toBe(0);
    });
  });

  describe('the caller names the range', () => {
    it('refuses to run without one', () => {
      const r = run([]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('There is no default range');
    });

    // "0 commit(s)" followed by "no attribution found" is a guard reporting success over nothing.
    // Reachable from CI: on a push to the default branch the merge base IS the pushed commit.
    it('refuses a range that names no commits', () => {
      const r = run(['--range', 'HEAD..HEAD']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('names no commits');
    });

    // A message, not a stack trace — the bar scripts/assert-executor-safety.mjs sets for both.
    it('refuses a range git cannot resolve, without a stack trace', () => {
      const r = run(['--range', 'no-such-ref..also-not-a-ref']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Cannot read the range');
      expect(r.stderr).not.toMatch(/^\s+at .*\(node:/m);
    });

    it('refuses an unknown mode rather than guessing', () => {
      const r = run(['--everything', 'x']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Unknown mode');
    });

    // A MODE WITHOUT ITS VALUE IS A USAGE ERROR, not a broken range. The arity check draws that
    // line; without it `--range` alone reaches git as an undefined rev and is answered with
    // "Cannot read the range", which tells the caller to fix a range they never named. Exit 1 like
    // every other refusal here: this guard has one failure meaning — not checked, or checked and
    // offending — so there is no second meaning for a second code to carry.
    it('answers --range without a value as a usage error, not as an unreadable range', () => {
      const r = run(['--range']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('There is no default range');
      expect(r.stderr).not.toContain('Cannot read the range');
    });

    it('ablated: without the arity check, --range alone is blamed on git instead', () => {
      const ablated = mutate([['process.argv.length !== 4', 'false']]);
      const r = run(['--range'], { guard: ablated });
      expect(r.stderr).not.toContain('There is no default range');
      expect(r.stderr).toContain('Cannot read the range');
    });
  });

  // ONE ABLATION PER PATTERN: remove it from a copy of the guard and exactly the fixture that pins
  // it must go green. A pattern no fixture distinguishes fails here, now.
  describe('ablations', () => {
    const CASES: Array<[string, string, string]> = [
      ['the Co-Authored-By pattern', "[/^Co-Authored-By:.*(claude|@anthropic\\.com)/i, 'a Co-Authored-By trailer naming Claude']", `feat: a\n\n${TRAILER}\n`],
      ['the Claude-Session pattern', "[/^Claude-Session:/i, 'a Claude-Session trailer']", 'feat: b\n\nClaude-Session: 0a1b2c3d\n'],
      ['the generated-with pattern', '[/Generated with \\[?Claude Code/i, "Claude Code\'s generated-with sign-off"]', 'feat: c\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'],
    ];

    for (const [what, anchor, body] of CASES) {
      it(`ablated: without ${what}, that trailer passes`, () => {
        const ablated = mutate([[anchor, '[/^\\u0000never\\u0000$/, \'disabled\']']]);
        const dir = repoWith([body]);
        expect(run(['--range', 'HEAD~1..HEAD'], { cwd: dir, guard: ablated }).status).toBe(0);
      });
    }
  });

  // The guard that is not wired into CI is a script nobody runs — the exact failure #86 was filed
  // about, one level up. Both events, because only one of them runs against the target branch.
  describe('wiring', () => {
    it('runs as its own CI job on both push and pull_request', () => {
      expect(
        ciSteps('attribution-guard', "node scripts/assert-no-attribution.mjs --range '${{ steps.range.outputs.range }}'"),
      ).toEqual([{ index: expect.any(Number), conditions: [] }]);
    });

    it('checks the pull request description too', () => {
      const command = `printf '%s' "$PR_BODY" | node scripts/assert-no-attribution.mjs --stdin 'the pull request description'`;
      expect(ciSteps('attribution-guard', command)).toEqual([
        { index: expect.any(Number), conditions: ["github.event_name == 'pull_request'"] },
      ]);
      // PR_BODY from the body; any other key that no script reads is already a condition above.
      const env = ciJobSteps('attribution-guard').find((s) => String(s.step.run).trim() === command)?.env;
      expect(expandAll(env, { 'github.event.pull_request.body': 'the body' })).toMatchObject({ PR_BODY: 'the body' });
    });

    // Both halves of the event coverage, because both revert to green. `edited` is not a
    // pull_request default, and without it a description that gains a trailer AFTER the green run
    // is never re-read. The push range is the merge base and not `before..after`, because
    // cancel-in-progress can cancel the run that would have read the skipped commits.
    it('covers a pull request description edited after the green run', () => {
      // Named in full: naming the list replaces the defaults, so dropping `synchronize` would leave
      // a pushed commit on an open PR unchecked.
      // These four in any order; the order means nothing to GitHub, and an extra type only adds a run.
      expect(ciTriggers()).toEqual({ push: null, pull_request: { types: expect.arrayContaining(['opened', 'synchronize', 'reopened', 'edited']) } });
    });

    // The range step RUN, as GitHub would run it, in a repository where the push before this one
    // was cancelled: main is base, m; the branch is base, f1, f2 (before), f3 (this push). It runs in
    // a clone, as actions/checkout leaves one: `origin` is the remote and there is no local main.
    function rangeFor(event: (fx: Record<string, string>) => Record<string, string>) {
      const origin = repoWith(['m']);
      const git = (...args: string[]) => gitIn(origin, ...args);
      const fx: Record<string, string> = { base: git('rev-parse', 'HEAD~1'), m: git('rev-parse', 'HEAD') };
      git('checkout', '-q', '-b', 'feature', fx.base);
      for (const c of ['f1', 'f2', 'f3']) {
        writeFileSync(join(origin, 'f'), `${c}\n`);
        git('commit', '-q', '-am', c);
        fx[c] = git('rev-parse', 'HEAD');
      }
      const dir = mkdtempSync(join(tmpdir(), 'attribution-clone-'));
      temps.push(dir);
      git('clone', '-q', origin, dir);
      const { step, env, conditions } = ciJobSteps('attribution-guard').find((s) => s.step.id === 'range') ?? {};
      const output = join(dir, 'github-output');
      writeFileSync(output, '');
      const ctx = event(fx);
      // `bash -e`, the shell GitHub uses for a `run` that declares none; `conditions` pins that it doesn't.
      spawnSync('bash', ['-e', '-c', expand(String(step?.run), ctx)], {
        cwd: dir,
        env: { ...isolated(), ...expandAll(env, ctx), GITHUB_OUTPUT: output },
      });
      return { conditions, output: readFileSync(output, 'utf8'), fx };
    }

    it('computes the push range from the merge base, which no cancelled run can shorten', () => {
      const { conditions, output, fx } = rangeFor((fx) => ({
        'github.event_name': 'push',
        'github.event.before': fx.f2,
        'github.ref': 'refs/heads/feature',
        'github.ref_name': 'feature',
        'github.sha': fx.f3,
        'github.event.repository.default_branch': 'main',
      }));
      expect(conditions).toEqual([]);
      expect(output).toBe(`range=${fx.base}..${fx.f3}\n`);
    });

    // On the default branch the merge base IS the push, and the guard refuses an empty range.
    it('checks the pushed tip itself on a push to the default branch', () => {
      const { output, fx } = rangeFor((fx) => ({
        'github.event_name': 'push',
        'github.ref': 'refs/heads/main',
        'github.ref_name': 'main',
        'github.sha': fx.m,
        'github.event.repository.default_branch': 'main',
      }));
      expect(output).toBe(`range=${fx.m}^..${fx.m}\n`);
    });

    it('takes the pull request range from base to head', () => {
      const { output, fx } = rangeFor((fx) => ({
        'github.event_name': 'pull_request',
        'github.event.pull_request.base.sha': fx.m,
        'github.event.pull_request.head.sha': fx.f3,
        'github.sha': fx.f2,
        'github.event.repository.default_branch': 'main',
      }));
      expect(output).toBe(`range=${fx.m}..${fx.f3}\n`);
    });

    // A shallow clone has no base commit, so the range would not resolve and the job would be
    // green-by-error. This is the one wiring detail whose absence is silent.
    it('checks out full history, or the range cannot be resolved', () => {
      // bare(), because the runner hands every input to the action as text: 0, '0' and ${{ 0 }} are the
      // same input, and an absent or empty one is the action's default depth of 1. This repository, at
      // its root (no `repository`, no `path`), before the range step reads it.
      const rangeAt = ciJobSteps('attribution-guard').findIndex((s) => s.step.id === 'range');
      expect(
        ciUses('attribution-guard', 'actions/checkout').map(({ index, step: { with: w = {} }, conditions }) => ({
          depth: bare(w['fetch-depth']), repository: w.repository, path: w.path, beforeRange: index < rangeAt, conditions,
        })),
      ).toEqual([{ depth: '0', beforeRange: true, conditions: [] }]);
    });
  });
});
