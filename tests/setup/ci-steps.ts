// The CI workflow as GitHub reads it: triggers, jobs → steps → `run`, parsed by a real YAML
// implementation rather than searched as text. ci.yml is mostly comment prose that quotes these very
// commands, so a text search finds a `#`-commented step, or one moved to another job, as readily as
// a live one. Ruby's Psych is the parser because it is a standard library on every runner and macOS
// and no YAML package is installed here.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

type Gate = { if?: unknown; 'continue-on-error'?: unknown };
type Step = Gate & { id?: string; run?: unknown; uses?: unknown; with?: Record<string, unknown> };
type Workflow = { on?: unknown; true?: unknown; jobs?: Record<string, Gate & { steps?: Step[] }> };

const CI_WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'ci.yml');

// safe_load with aliases, because GitHub accepts anchors and Psych 4+ `load_file` refuses them.
// A thrown error, not a skip, when Ruby is missing: a skipped wiring case is a green one.
export function ciWorkflow(path = CI_WORKFLOW): Workflow {
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

// Every step of `job` whose whole `run` is `command`, with its position and its `if` (`false`
// included) and continue-on-error, on the job or on the step. NOT read: env, shell, needs, or an
// earlier step that rewrites the command. No check on this workflow's own jobs closes these,
// because the job still succeeds (or is skipped, which counts as success). The boundary is review of
// `.github/` changes: CODEOWNERS on `.github/workflows/` plus required code-owner review, or a
// ruleset-required workflow run from the base ref.
// ponytail: whole run, not a line of it — a line after `exit 0` in a script is text, not a step,
// and telling which lines execute would take a shell interpreter.
export function ciSteps(job: string, command: string, path = CI_WORKFLOW) {
  const j = ciWorkflow(path).jobs?.[job];
  return (j?.steps ?? []).flatMap((step, index) =>
    typeof step.run === 'string' && step.run.trim() === command
      ? [{ index, conditions: [...conditions(j), ...conditions(step)] }]
      : [],
  );
}

// Every step of `job` that uses `action` at any version, with its `with` inputs and the same gates.
// Lowercased, because GitHub resolves `Actions/checkout` to the same repository.
export function ciUses(job: string, action: string, path = CI_WORKFLOW) {
  const j = ciWorkflow(path).jobs?.[job];
  return (j?.steps ?? []).flatMap((step, index) =>
    typeof step.uses === 'string' && step.uses.split('@')[0].toLowerCase() === action
      ? [{ index, with: step.with, conditions: [...conditions(j), ...conditions(step)] }]
      : [],
  );
}
