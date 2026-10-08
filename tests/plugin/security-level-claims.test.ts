// tests/plugin/security-level-claims.test.ts
// #59 acceptance test 2, re-aimed by the owner decision of 2026-10-06: no shipped text may promise
// a selectable screening level, because the shipped plugin offers none. `.claude-plugin/plugin.json`
// declares no configuration since #68 (pinned shut in claude-plugin-manifest.test.ts), the `.mcpb`
// dialog is gone with the retired MCPB path (#103), and src/server.ts returns 'standard' for an
// absent value — so an operator who believes they chose `strict` or `off` silently gets `standard`.
//
// Its own file rather than part of a manifest suite: the claim is about SHIPPED TEXT, not about one
// artefact's shape, and it now rests entirely on README.md.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const readme = read('README.md');
const lineWith = (haystack: string, needle: string) => haystack.split('\n').find((l) => l.includes(needle)) ?? '';
// Backticks are README markup, not substance.
const plain = (s: string) => s.replace(/`/g, '');

// The shipped places the owner decision names, each located by a stable anchor rather than by line
// number, with the exact wording that promised a choice and must not come back. Every `text()`
// returns the RAW shipped excerpt, never a parsed value.
//
// Two of the four sites are gone with the MCPB path (#103), not weakened: the `manifest.json`
// security_level description and the README's Desktop-Extension dialog table row were both part of
// that path's surface. #59 AC2 is carried by the two that remain — the installed plugin's own
// configuration table and the Security section.
const CLAIM_SITES = [
  {
    where: 'README.md plugin-configuration table row',
    text: () => lineWith(readme, '| `security_level` | `strict`'),
    withdrawn: 'Prompt-injection screening (default `standard`) |',
  },
  {
    where: 'README.md Security section',
    text: () => readme.slice(readme.indexOf('- **Prompt-injection screening.**')).split('\n- **')[0],
    withdrawn: 'Level via `security_level` (`strict` | `standard` | `off`).',
  },
] as const;

// By name, never by index: inserting a claim site must not silently re-aim a test at another one.
const site = (where: string) => {
  const found = CLAIM_SITES.find((s) => s.where === where);
  if (!found) throw new Error(`no claim site named ${where}`);
  return found;
};

const securitySection = () => site('README.md Security section').text();

describe('no shipped text promises a security level the plugin does not offer (#59)', () => {
  // One assertion block per place: the correction is there AND the old promise is gone. A revert to
  // today's wording fails the first half; an edit that APPENDS the correction without removing the
  // promise fails the second, which a `fixed`-only check would wave through.
  it.each(CLAIM_SITES.map((s) => [s.where, s] as const))('%s says the level is fixed, and no longer promises a choice', (where, s) => {
    const text = plain(s.text());
    expect(text, where).not.toBe('');
    expect(text.toLowerCase(), where).toContain('fixed');
    expect(text.toLowerCase(), where).toContain('standard');
    expect(text, where).not.toContain(s.withdrawn);
  });

  // The two paths that CAN set it, named where the operator reads about it, so the withdrawal is a
  // correction and not just a deletion.
  it('the Security section names the only two paths that can still set a level', () => {
    const section = securitySection();
    expect(section).toContain('ZENDESK_SECURITY_LEVEL');
    expect(section).toContain('started by hand');
    expect(section).toContain('remote-connector');
  });

  // The field the decision forbids bringing back. claude-plugin-manifest.test.ts:39-40 pins the
  // `env` half; this pins that the plugin manifest names the level nowhere at all.
  it('the Claude Code plugin manifest still declares no security level', () => {
    expect(read('.claude-plugin/plugin.json')).not.toContain('security_level');
  });
});
