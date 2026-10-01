// tests/plugin/no-real-keychain.test.ts
// A breach of the rule in tests/auth/keychain.ts used to be invisible: a case that resolved a
// configuration without passing the seam reached the DEVELOPER's login keychain, where it quietly
// worked — and created an item on one, measured at 11:05:08Z — while on Linux CI the same code read
// nothing and passed for a different reason. Neither outcome is a test.
//
// So the rule is checked here instead of hoped for. Its reach, stated: per FILE, not per call. A file
// that resolves a configuration must obtain the fake runner, which is one import; a file that imports it
// and then forgets it on one of several calls is not caught. That is the cheap half of the problem, and
// it is the half that happens.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = join(dirname(fileURLToPath(import.meta.url)), '..');

// Both doors into the Keychain path: createServer reads the token-store key through the spread in
// resolveOrDegrade, resolveAuthConfig reads it and the three values directly. Matched on the IMPORT, not
// on the call, because `createServer` is also node:http's and half the suite binds a port with it.
const RESOLVES_CONFIG = /import \{[^}]*\b(createServer|resolveAuthConfig)\b[^}]*\} from '[^']*src\/(server|auth\/config)\.js'/s;
const HAS_SEAM = /from '[^']*keychain\.js'|\bnoKeychain\b/;

// The two files that legitimately name those calls without resolving anything: this guard itself, and
// the executor-safety fixtures, which contain a local function of the same name as a string.
const EXEMPT = new Set(['plugin/no-real-keychain.test.ts', 'plugin/executor-safety-guard.test.ts']);

function testFiles(): string[] {
  return readdirSync(TESTS, { recursive: true })
    .map((entry) => String(entry).split('\\').join('/'))
    .filter((rel) => rel.endsWith('.ts') && !EXEMPT.has(rel));
}

describe('no test reaches the real macOS Keychain', () => {
  it('every file that resolves a configuration takes the fake `security` runner', () => {
    const offenders = testFiles().filter((rel) => {
      const source = readFileSync(join(TESTS, rel), 'utf8');
      return RESOLVES_CONFIG.test(source) && !HAS_SEAM.test(source);
    });
    expect(
      offenders,
      `these files resolve a Zendesk configuration without the fake Keychain, so they would reach the ` +
        `real one on macOS and nothing at all on Linux:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  // The hole this guard did NOT catch, now closed on the production side: a test can inject a runner for
  // every READ and still have the WRITE escape to the real keychain, because the writer had a default
  // that took no runner. CI caught it; three items landed in a developer's login keychain. So every call
  // into store-key.ts from the rest of src/ must pass the runner it was given.
  it('passes the injected runner to every Keychain call, writes included', () => {
    const source = readFileSync(join(TESTS, '..', 'src', 'server.ts'), 'utf8');
    const calls = [...source.matchAll(/\b(readKeychainConfig|resolveTokenStoreKey|writeKeychainConfig)\(([^)]*)\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const [call, name, args] of calls) {
      expect(args, `${name} in server.ts must be given the runner: ${call}`).toContain('security');
    }
  });

  // And the seam itself is the only way in: src/ reaches `security` from one file, which
  // tests/plugin/no-process-spawn.test.ts pins, and that file takes a RunSecurity everywhere.
  it('the production path has exactly one default runner, and it is injectable', () => {
    const source = readFileSync(join(TESTS, '..', 'src', 'auth', 'store-key.ts'), 'utf8');
    const exported = [...source.matchAll(/^export function (\w+)\(([\s\S]*?)\)[:\s]/gm)].map((m) => [m[1], m[2]]);
    expect(exported.length).toBeGreaterThan(2);
    for (const [name, params] of exported) {
      // encKeyStrengthBytes measures a string; runSecurity IS the runner, and its own parameter is the
      // binary, which only its own tests pass.
      if (name === 'encKeyStrengthBytes' || name === 'runSecurity') continue;
      expect(params, `${name} must take the runner as a parameter`).toMatch(/RunSecurity = runSecurity/);
    }
  });
});
