import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = join(root, 'scripts', 'assert-no-attribution.mjs');
const CI = join(root, '.github', 'workflows', 'ci.yml');

const temps: string[] = [];
const mutants: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of mutants.splice(0)) rmSync(f, { force: true });
});

type Run = { status: number; stdout: string; stderr: string };

const run = (args: string[], input?: string, guard = GUARD): Run => {
  const r = spawnSync('node', [guard, ...args], { encoding: 'utf8', input, cwd: root });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
};

// A real repository with real commits, because the guard reads commit bodies through git. Asserting
// against a string in a file would not notice the day `git log --format` stops producing records.
function repoWith(bodies: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-guard-'));
  temps.push(dir);
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
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

const inRepo = (dir: string, args: string[]): Run => {
  const r = spawnSync('node', [GUARD, ...args], { encoding: 'utf8', cwd: dir });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
};

function mutate(edits: Array<[string, string]>): string {
  let code = readFileSync(GUARD, 'utf8');
  for (const [find, replace] of edits) {
    expect(code, `mutation anchor missing: ${find.slice(0, 50)}`).toContain(find);
    code = code.replace(find, replace);
  }
  const path = join(root, 'scripts', `.mutant-attr-${Math.random().toString(36).slice(2)}.mjs`);
  mutants.push(path);
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

  // The two real commits in THIS repository's history: the violation that got through during #76
  // and the prose citation that must not be mistaken for one. Fixtures prove the patterns; these
  // prove the patterns were derived from what actually happened.
  describe('against this repository’s own history', () => {
    it('fails fbc3fab, the trailer that reached a pushed branch during #76', () => {
      const r = run(['--range', 'fbc3fab~1..fbc3fab']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Co-Authored-By trailer naming Claude');
    });

    it('passes c314138, whose body explains the rule in prose', () => {
      const r = run(['--range', 'c314138~1..c314138']);
      expect(r.status).toBe(0);
    });
  });

  describe('pull request descriptions', () => {
    it('fails a description carrying the generated-with sign-off', () => {
      const r = run(['--stdin', 'the pull request description'], 'Summary.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('the pull request description');
    });

    it('passes a description that merely discusses the rule', () => {
      expect(run(['--stdin', 'the pull request description'], PROSE).status).toBe(0);
    });
  });

  describe('the caller names the range', () => {
    it('refuses to run without one', () => {
      const r = run([]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('There is no default range');
    });

    it('refuses an unknown mode rather than guessing', () => {
      const r = run(['--everything', 'x']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Unknown mode');
    });
  });

  // ONE ABLATION PER PATTERN: remove it from a copy of the guard and exactly the fixture that pins
  // it must go green. A pattern no fixture distinguishes fails here, now.
  describe('ablations', () => {
    const CASES: Array<[string, string, string]> = [
      ['the Co-Authored-By pattern', "[/^Co-Authored-By:.*(claude|@anthropic\\.com)/im, 'a Co-Authored-By trailer naming Claude']", `feat: a\n\n${TRAILER}\n`],
      ['the Claude-Session pattern', "[/^Claude-Session:/im, 'a Claude-Session trailer']", 'feat: b\n\nClaude-Session: 0a1b2c3d\n'],
      ['the generated-with pattern', '[/Generated with \\[?Claude Code/i, "Claude Code\'s generated-with sign-off"]', 'feat: c\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'],
    ];

    for (const [what, anchor, body] of CASES) {
      it(`ablated: without ${what}, that trailer passes`, () => {
        const ablated = mutate([[anchor, '[/^\\u0000never\\u0000$/, \'disabled\']']]);
        const dir = repoWith([body]);
        const r = spawnSync('node', [ablated, '--range', 'HEAD~1..HEAD'], { cwd: dir, encoding: 'utf8' });
        expect(r.status).toBe(0);
      });
    }

    it('ablated: each pattern still catches the OTHER two, so the three are not one rule', () => {
      const ablated = mutate([[CASES[0][1], '[/^\\u0000never\\u0000$/, \'disabled\']']]);
      for (const [, , body] of CASES.slice(1)) {
        const dir = repoWith([body]);
        const r = spawnSync('node', [ablated, '--range', 'HEAD~1..HEAD'], { cwd: dir, encoding: 'utf8' });
        expect(r.status).toBe(1);
      }
    });
  });

  // The guard that is not wired into CI is a script nobody runs — the exact failure #86 was filed
  // about, one level up. Both events, because only one of them runs against the target branch.
  describe('wiring', () => {
    const ci = () => readFileSync(CI, 'utf8');

    it('runs as its own CI job on both push and pull_request', () => {
      expect(ci()).toContain('attribution-guard:');
      expect(ci()).toContain('scripts/assert-no-attribution.mjs --range');
      expect(ci()).toMatch(/^on:\n(\s+push:\n\s+pull_request:|\s+pull_request:\n\s+push:)/m);
    });

    it('checks the pull request description too', () => {
      expect(ci()).toContain("--stdin 'the pull request description'");
    });

    // A shallow clone has no base commit, so the range would not resolve and the job would be
    // green-by-error. This is the one wiring detail whose absence is silent.
    it('checks out full history, or the range cannot be resolved', () => {
      expect(ci()).toMatch(/attribution-guard:[\s\S]*?fetch-depth: 0/);
    });

    it('passes over this branch’s own commits', () => {
      const base = spawnSync('git', ['merge-base', 'origin/development', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).stdout.trim();
      expect(base, 'no merge-base with origin/development').not.toBe('');
      const r = run(['--range', `${base}..HEAD`]);
      expect(r.status, r.stderr).toBe(0);
    });
  });
});
