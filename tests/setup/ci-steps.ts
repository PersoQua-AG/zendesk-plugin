// The CI workflow as GitHub reads it: triggers, jobs → steps → `run`, parsed by a real YAML
// implementation rather than searched as text. ci.yml is mostly comment prose that quotes these very
// commands, so a text search finds a `#`-commented step, or one moved to another job, as readily as
// a live one. Ruby's Psych is the parser because it is a standard library on every runner and macOS
// and no YAML package is installed here.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

type Gate = { if?: unknown; 'continue-on-error'?: unknown; shell?: unknown; defaults?: { run?: { shell?: unknown } }; env?: Record<string, unknown> };
type Step = Gate & { id?: string; run?: unknown; uses?: unknown; with?: Record<string, unknown> };
type Workflow = Gate & { on?: unknown; true?: unknown; jobs?: Record<string, Gate & { needs?: unknown; steps?: Step[] }> };

const CI_WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'ci.yml');

// safe_load with aliases, because GitHub accepts anchors and Psych 4+ `load_file` refuses them.
// A thrown error, not a skip, when Ruby is missing: a skipped wiring case is a green one.
function ciWorkflow(path = CI_WORKFLOW): Workflow {
  const script = 'print JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases: true))';
  const ruby = spawnSync('ruby', ['-ryaml', '-rjson', '-e', script, path], { encoding: 'utf8' });
  if (ruby.status !== 0) throw new Error(`ruby could not parse ${path}: ${ruby.error?.message ?? ruby.stderr}`);
  return JSON.parse(ruby.stdout) as Workflow;
}

// YAML 1.1 reads a bare `on:` key as the boolean true; a quoted "on" stays a string. Neither present
// answers undefined, which no trigger assertion accepts.
export const ciTriggers = (path = CI_WORKFLOW) => {
  const wf = ciWorkflow(path);
  return wf.on ?? wf.true;
};

// A value without its `${{ }}`: GitHub evaluates `${{ false }}` to what `false` says.
export const bare = (v: unknown) => String(v).replace(/^\$\{\{\s*|\s*\}\}$/g, '');

// `success()` and `false` are what GitHub uses when `if` and continue-on-error are absent; `if: true`
// is the same default, because success() is implied when no status function is named.
const conditions = (g: Gate | undefined) => [
  ...(g?.if === undefined || ['success()', 'true'].includes(bare(g.if)) ? [] : [g.if]),
  ...(g?.['continue-on-error'] === undefined || bare(g['continue-on-error']) === 'false' ? [] : ['continue-on-error']),
];

// A declared shell decides what `run` means: `shell: bash -c 'true' {0}` never reads the script.
const shells = (...gs: Array<Gate | undefined>) =>
  gs.flatMap((g) => g?.shell ?? g?.defaults?.run?.shell ?? []).map((s) => `shell: ${String(s)}`);

// Every step of `job` with its position, its env (workflow, then job, then step) and whatever stops
// its script from gating: an `if` (`false` included), continue-on-error or a shell on the workflow,
// job or step; any `needs`, since a skipped needed job skips this one; and an env key no script here
// reads, which can only change how the tools run (`npm_config_script_shell`, `NODE_OPTIONS`).
// ponytail: a script that names such a key by hand hides it. NOT read: an earlier step that rewrites
// the command. No status check closes that, because the job still succeeds. The boundary is review
// of `.github/` changes: CODEOWNERS on `.github/workflows/` plus required code-owner review, or a
// ruleset-required workflow run from the base ref.
export function ciJobSteps(job: string, path = CI_WORKFLOW) {
  const wf = ciWorkflow(path);
  const j = wf.jobs?.[job];
  const scripts = Object.values(wf.jobs ?? {}).flatMap((x) => x.steps ?? []).map((x) => String(x.run ?? '')).join('\n');
  return (j?.steps ?? []).map((step, index) => {
    const env = { ...wf.env, ...j?.env, ...step.env };
    const unread = Object.keys(env).filter((k) => !new RegExp(`\\$\\{?${k}\\b`).test(scripts));
    const needs = [j?.needs ?? []].flat().map((n) => `needs: ${String(n)}`);
    return { step, index, env, conditions: [...conditions(j), ...conditions(step), ...shells(wf, j, step), ...needs, ...unread.map((k) => `env: ${k}`)] };
  });
}

// Every step of `job` whose whole `run` is `command`.
// ponytail: whole run, not a line of it — a line after `exit 0` in a script is text, not a step,
// and telling which lines execute would take a shell interpreter.
export const ciSteps = (job: string, command: string, path = CI_WORKFLOW) =>
  ciJobSteps(job, path).flatMap(({ step, index, conditions }) =>
    typeof step.run === 'string' && step.run.trim() === command ? [{ index, conditions }] : [],
  );

// Every step of `job` that uses `action` at any version, lowercased because GitHub resolves
// `Actions/checkout` to the same repository.
export const ciUses = (job: string, action: string, path = CI_WORKFLOW) =>
  ciJobSteps(job, path).filter(({ step }) => typeof step.uses === 'string' && step.uses.split('@')[0].toLowerCase() === action);
