// scripts/assert-no-attribution.mjs
// The owner's rule — no Claude attribution — enforced instead of remembered.
//
// WHAT THIS SCRIPT INSPECTS, AND WHAT IT THEREFORE DOES NOT. Commit MESSAGE BODIES in a named
// range, and text handed on stdin. Not file contents: a trailer committed into a README or a pull
// request template passes here, and is a review matter. Not the author or committer IDENTITY
// either — a commit authored as `Claude <noreply@anthropic.com>` has no trailer and passes. Both
// are deliberate omissions and not oversights; widening to either is its own change, with its own
// false-positive question to answer.
//
// WHY IT IS A SCRIPT AND NOT A HABIT. The rule is recorded in the hub memory
// (ops/memory/feedback_no-claude-attribution-any-repo.md) and that file asserts CI enforces it.
// Measured in this repository on dd6e564: `ls .github/workflows/` → ci.yml alone, and
// `git grep -in attribution -- .github/` → no output. Measured in the sibling the memory names as
// having the job, foerdermittel-assistent, on its checkout of the same day:
// `grep -rin 'claude\|attribution' .github/ scripts/` → no output there either. So the claim was
// false in both places, and it stayed trusted because it was read rather than run. It failed in
// practice during #76: commit fbc3fab on qa/v1-executor-scan-root was pushed with a
// `Co-Authored-By:` trailer naming Claude, nothing rejected the push, nothing flagged the PR, and a
// human caught it. That is the part that does not scale.
//
// WHAT IS MATCHED, AND WHY NOT `grep -i claude`. A blunt name match over a commit body also trips a
// commit that CITES the rule in prose — this repository has one, c314138, whose body explains why
// files were copied rather than merged and names the rule to do it. A guard that cannot tell a
// violation from a correct explanation of the violation teaches people to stop explaining. So the
// match is on the TRAILER FORMS, which are machine-written and have no prose use:
//
//   - a `Co-Authored-By:` trailer whose value names Claude or an anthropic.com address
//   - a `Claude-Session:` trailer
//   - `Generated with [Claude Code]`, the tool's own sign-off, in any line position
//
// The first two must stand at the start of their line, as a trailer does. The third does not: it is
// a sign-off line whose own text is the signature, and quoting it inside a sentence is not
// something that happens by accident the way quoting a trailer name is.
//
// PR DESCRIPTIONS ARE COVERED TOO, not left to review: --stdin runs the same patterns over text
// handed on stdin, and .github/workflows/ci.yml feeds it the pull request body. The rule names
// commits, PRs and issue comments alike; issue comments stay a review matter because no event in
// this workflow carries them.
//
// THE CALLER NAMES THE RANGE, exactly as the two sibling guards make the caller name the tree:
// there is no default, because a guard that invents its own subject reports success over whatever
// it happened to look at. CI computes the range per event — see the job.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RULES = [
  // `violations()` tests one line at a time, so `^` anchors to the line without `m`; `m` is kept
  // off rather than carried as decoration that suggests a multi-line subject these never see.
  [/^Co-Authored-By:.*(claude|@anthropic\.com)/i, 'a Co-Authored-By trailer naming Claude'],
  [/^Claude-Session:/i, 'a Claude-Session trailer'],
  [/Generated with \[?Claude Code/i, "Claude Code's generated-with sign-off"],
];

// The offending LINE, not just the commit: the author has to see the text to delete it.
function violations(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    for (const [pattern, what] of RULES) {
      if (pattern.test(line)) found.push({ line: i + 1, text: line.trim(), what });
    }
  });
  return found;
}

const [mode, arg] = process.argv.slice(2);

if (process.argv.length !== 4) {
  console.error(
    'Usage:\n' +
      '  node scripts/assert-no-attribution.mjs --range <git range>   # commit bodies in the range\n' +
      '  node scripts/assert-no-attribution.mjs --stdin <label>       # text on stdin, e.g. a PR body\n' +
      '\nThere is no default range. A guard that picks its own subject reports success over whatever\n' +
      'it happened to look at — the same reason the executor and port guards take their tree.',
  );
  process.exit(1);
}

const offences = [];
let subject;

if (mode === '--stdin') {
  subject = arg;
  const text = readFileSync(0, 'utf8');
  for (const v of violations(text)) offences.push({ where: `${arg}:${v.line}`, ...v });
} else if (mode === '--range') {
  subject = `commits in ${arg}`;
  // NUL-separated so a body containing any line of text cannot forge a record boundary.
  const log = execFileSync('git', ['log', '--format=%H%x1f%s%x1f%B%x1e', arg], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const records = log.split('\x1e').filter((r) => r.trim() !== '');
  for (const record of records) {
    const [sha, title, body] = record.replace(/^\n/, '').split('\x1f');
    for (const v of violations(body ?? '')) {
      offences.push({ where: `${sha.slice(0, 8)} ("${title}") body line ${v.line}`, ...v });
    }
  }
  console.log(`Attribution check: ${records.length} commit(s) in ${arg}.`);
} else {
  console.error(`Unknown mode: ${mode}. Expected --range or --stdin.`);
  process.exit(1);
}

if (offences.length > 0) {
  console.error(`\nRefusing ${subject}: ${offences.length} Claude attribution(s).`);
  for (const o of offences) {
    console.error(`  - ${o.where}: ${o.what}`);
    console.error(`      ${o.text}`);
  }
  console.error(
    '\nThis repository carries no Claude attribution — not in a commit body, not in a pull request\n' +
      'description. Remove the line and amend or rewrite the commit, then force-push your own branch\n' +
      '(never a protected one). Prose that MENTIONS the rule is fine and is not matched here; only\n' +
      'the trailer forms are.',
  );
  process.exit(1);
}

console.log(`No Claude attribution in ${subject}.`);
