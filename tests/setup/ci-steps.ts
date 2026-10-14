// The CI workflow as GitHub reads it: jobs → steps → `run`, parsed by a real YAML implementation
// rather than searched as text. ci.yml is mostly comment prose that quotes these very commands, so
// a text search finds a `#`-commented step, or one moved to another job, as readily as a live one.
// Ruby's Psych is the parser because it is a standard library on every runner and macOS and no
// YAML package is installed here; YAML 1.1, so the `on:` key reads back as `true` (not used here).
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

type Step = { run?: unknown; if?: unknown; 'continue-on-error'?: unknown };
type Workflow = { jobs?: Record<string, { if?: unknown; steps?: Step[] }> };

const CI_WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'ci.yml');

function parseWorkflow(path: string): Workflow {
  const ruby = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'print JSON.generate(YAML.load_file(ARGV[0]))', path], {
    encoding: 'utf8',
  });
  if (ruby.status !== 0) throw new Error(`ruby could not parse ${path}: ${ruby.error?.message ?? ruby.stderr}`);
  return JSON.parse(ruby.stdout) as Workflow;
}

// Every step of `job` that has `command` as one whole line of its `run`, with its position and
// whatever could stop it from gating: a job or step `if` (`false` included), or continue-on-error.
// A whole line, so a shell comment or an `echo` naming the command in a `run: |` block is not it.
export function ciSteps(job: string, command: string, path = CI_WORKFLOW) {
  const j = parseWorkflow(path).jobs?.[job];
  return (j?.steps ?? []).flatMap((step, index) => {
    if (typeof step.run !== 'string' || !step.run.split('\n').some((line) => line.trim() === command)) return [];
    const conditions = [j?.if, step.if, step['continue-on-error'] ? 'continue-on-error' : undefined];
    return [{ index, conditions: conditions.filter((c) => c !== undefined) }];
  });
}
