import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function envWithLevel(level?: string): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-seclevel-'));
  dirs.push(dataDir);
  const env: NodeJS.ProcessEnv = {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
    CLAUDE_PLUGIN_DATA: dataDir,
  };
  if (level !== undefined) env.ZENDESK_SECURITY_LEVEL = level;
  return env;
}

function build(level?: string) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const { ctx } = createServer(envWithLevel(level));
  return {
    securityLevel: ctx.securityLevel,
    warnings: warn.mock.calls.map((c) => String(c[0])),
    stdoutWrites: [...log.mock.calls, ...info.mock.calls, ...debug.mock.calls, ...stdout.mock.calls].map(String),
  };
}

// An unreadable security level used to fall to 'standard' without a word: an operator who asked for
// stricter injection screening silently got weaker screening, and nothing in the running server
// showed it. The fix is loudness plus a fail-closed direction, never a quiet downgrade.
describe('security level — an unrecognized value is never a silent downgrade', () => {
  it.each([
    ['a typo', 'stict'],
    ['a different typo', 'stirct'],
    ['a word that is not a level at all', 'maximum'],
    ['an empty-looking value that is not blank', '.'],
    ['a numeric value', '2'],
  ])('warns and resolves to strict for %s: %s', (_label, value) => {
    const { securityLevel, warnings } = build(value);
    expect(securityLevel).toBe('strict');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`ZENDESK_SECURITY_LEVEL "${value}"`);
    expect(warnings[0]).toContain('strict | standard | off');
    expect(warnings[0]).toContain('"security_level"');
  });

  it('never resolves an unrecognized value to a WEAKER level than the operator may have meant', () => {
    for (const value of ['stict', 'of', 'standrd', 'none', 'disabled']) {
      expect(build(value).securityLevel).toBe('strict');
    }
  });

  // stdout is the MCP stdio transport (server.ts connects StdioServerTransport to it); a warning
  // written there corrupts the protocol frame. The warning belongs on stderr and nowhere else.
  it('writes the warning to stderr only — never to stdout, which carries the MCP protocol', () => {
    const { warnings, stdoutWrites } = build('stict');
    expect(warnings).toHaveLength(1);
    expect(stdoutWrites).toHaveLength(0);
  });
});

describe('security level — values that must stay silent', () => {
  it.each([
    ['strict', 'strict', 'strict'],
    ['standard', 'standard', 'standard'],
    ['off', 'off', 'off'],
    ['capitalized — unambiguous, so normalized rather than warned', 'Strict', 'strict'],
    ['shouted', 'OFF', 'off'],
    ['with a trailing space from a copy-paste', 'strict ', 'strict'],
    ['with surrounding whitespace', '  standard  ', 'standard'],
  ])('accepts %s (%s) without a warning', (_label, value, expected) => {
    const { securityLevel, warnings } = build(value);
    expect(securityLevel).toBe(expected);
    expect(warnings).toEqual([]);
  });

  // Absent is not a typo — it is the default both manifests declare. Degrading it to 'strict' would
  // change the shipped behaviour of every untouched installation.
  it.each([
    ['unset', undefined],
    ['blank', ''],
    ['an unsubstituted placeholder', '${user_config.security_level}'],
  ])('treats %s as the shipped default, standard, without a warning', (_label, value) => {
    const { securityLevel, warnings } = build(value);
    expect(securityLevel).toBe('standard');
    expect(warnings).toEqual([]);
  });
});
