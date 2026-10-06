// tests/plugin/security-level-claims.test.ts
// #59 acceptance test 2, re-aimed by the owner decision of 2026-10-06: no shipped text may promise
// a selectable screening level, because the shipped plugin offers none. `.claude-plugin/plugin.json`
// declares no configuration since #68 (pinned shut in claude-plugin-manifest.test.ts:39-40), the
// `.mcpb` dialog is the retired path, and src/server.ts returns 'standard' for an absent value — so
// an operator who believes they chose `strict` or `off` silently gets `standard`.
//
// Its own file rather than an extension of mcpb-manifest.test.ts: that suite is scoped to one
// artefact's shape ("what the MCPB manifest has to be right about stays here",
// mcpb-manifest.test.ts:96-97). This claim spans manifest.json AND README.md and belongs to neither
// file's shape, so putting it there would give that suite a second subject.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const readme = read('README.md');
// Backticks are README markup, not substance; the manifest description is plain dialog text.
const plain = (s: string) => s.replace(/`/g, '');

// The four shipped places the owner decision names, each located by a stable anchor rather than by
// line number, with the exact wording that promised a choice and must not come back.
const CLAIM_SITES = [
  {
    where: 'manifest.json security_level description',
    text: () => manifest.user_config.security_level.description as string,
    withdrawn: 'screened for prompt injection."',
  },
  {
    where: 'README.md Desktop-Extension dialog table row',
    text: () => readme.split('\n').find((l) => l.includes('| Injection-Screening Level |')) ?? '',
    withdrawn: '| Injection-Screening Level | no | `standard` |',
  },
  {
    where: 'README.md plugin-configuration table row',
    text: () => readme.split('\n').find((l) => l.startsWith('| `security_level` |')) ?? '',
    withdrawn: 'Prompt-injection screening (default `standard`) |',
  },
  {
    where: 'README.md Security section',
    text: () => readme.slice(readme.indexOf('- **Prompt-injection screening.**')).split('\n- **')[0],
    withdrawn: 'Level via `security_level` (`strict` | `standard` | `off`).',
  },
] as const;

describe('no shipped text promises a security level the plugin does not offer (#59)', () => {
  it.each(CLAIM_SITES.map((s) => [s.where, s] as const))('%s says the level is fixed', (where, site) => {
    const text = plain(site.text());
    expect(text, where).not.toBe('');
    expect(text.toLowerCase(), where).toContain('fixed');
    expect(text.toLowerCase(), where).toContain('standard');
  });

  it.each(CLAIM_SITES.map((s) => [s.where, s] as const))('%s no longer carries its old promise', (where, site) => {
    const haystack = where.startsWith('manifest') ? read('manifest.json') : readme;
    expect(haystack, where).not.toContain(site.withdrawn);
  });

  // The two paths that CAN set it, named where the operator reads about it, so the withdrawal is a
  // correction and not just a deletion.
  it('the Security section names the only two paths that can still set a level', () => {
    const section = CLAIM_SITES[3].text();
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
