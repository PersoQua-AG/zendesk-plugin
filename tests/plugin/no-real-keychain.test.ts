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
import ts from 'typescript';

const TESTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(TESTS, '..', 'src');

// Both doors into the Keychain path: createServer reads the token-store key through the spread in
// resolveOrDegrade, resolveAuthConfig reads it and the three values directly.
const DOORS = ['createServer', 'resolveAuthConfig'];
// What counts as handing the fake runner in. `security:` covers createServer's deps object; the named
// helpers and `.run` (what fakeKeychain exposes its runner as) cover resolveAuthConfig's positional
// argument; noKeychain is the production opt-out the remote bridge passes.
const SEAM =
  /\bsecurity\s*:|\b(keychain|configuredKeychain|deniedKeychain|fakeKeychain)\s*\(|\bnoKeychain\b|\bsecurity\b|\.run\b/;

// This guard itself names the doors in strings and in a regex.
const EXEMPT = new Set(['plugin/no-real-keychain.test.ts']);

// Per CALL, not per file. The first version of this matched IMPORTS, and the original offender satisfied
// it: tests/auth/config.placeholder.test.ts imported the fake once and then called createServer eleven
// times without it, which still read the developer's own login keychain — measured, a 44-character value
// with the prefix of the real item. A regex cannot read an argument list that spans lines, so the calls
// are found with the TypeScript parser (already a devDependency; scripts/assert-executor-safety.mjs is
// the precedent) and each one's own argument text is what gets checked.
function unseamedCalls(rel: string, source: string): string[] {
  return doorCalls(TESTS, rel, source)
    .filter((call) => !SEAM.test(call.args))
    .map((call) => `${call.at}  ${call.name}(${call.args.slice(0, 60)})`);
}

// Every call in a tree, by the file it sits in, with the names actually imported from the two doors. The
// import check is what keeps node:http's `createServer` — which half the suite binds a port with — out of
// the result.
function doorCalls(root: string, rel: string, source: string): { at: string; name: string; args: string }[] {
  const imported = new Set(
    [...source.matchAll(/import (?:type )?\{([^}]*)\} from '[^']*(?:src\/)?(?:server|auth\/config|\.\.\/server)\.js'/gs)].flatMap(
      (m) => m[1].split(',').map((name) => name.trim().split(/\s+as\s+/).pop() as string),
    ),
  );
  const doors = DOORS.filter((door) => imported.has(door));
  if (doors.length === 0) return [];
  const file = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
  const found: { at: string; name: string; args: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && doors.includes(node.expression.text)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      found.push({
        at: `${rel}:${line + 1}`,
        name: node.expression.text,
        args: node.arguments.map((argument) => argument.getText(file)).join(', '),
      });
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return found;
}

function tsFiles(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map((entry) => String(entry).split('\\').join('/'))
    .filter((rel) => rel.endsWith('.ts'));
}

function testFiles(): string[] {
  return readdirSync(TESTS, { recursive: true })
    .map((entry) => String(entry).split('\\').join('/'))
    .filter((rel) => rel.endsWith('.ts') && !EXEMPT.has(rel));
}

describe('no test reaches the real macOS Keychain', () => {
  it('every call that resolves a configuration is given the fake `security` runner', () => {
    const offenders = testFiles().flatMap((rel) => unseamedCalls(rel, readFileSync(join(TESTS, rel), 'utf8')));
    expect(
      offenders,
      `these CALLS resolve a Zendesk configuration without the fake Keychain, so they reach the real one ` +
        `on macOS and nothing at all on Linux:\n${offenders.join('\n')}`,
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

  // src/ as well, because a per-path fix that leaves the next path open is what produced a whole review
  // round: buildRemoteApp opted its own resolution out of the Keychain while src/remote/session-manager.ts
  // built EVERY SESSION on the default runner, so a macOS-hosted bridge would have served every remote
  // user out of the operator's personal client secret. There is exactly ONE place the real runner belongs,
  // and it is named here rather than left to be inferred.
  // The two places the real runner belongs, each for its own reason: the stdio entrypoint IS the plugin on
  // the user's machine, and the authorize CLI is a person running `npm run authorize` on theirs — it has to
  // read the very key the server will decrypt with. Everything else in src/ either serves other people (the
  // remote bridge) or is library code, and both must be handed a runner.
  const MAY_DEFAULT = ['server.ts', 'bin/authorize.ts'];

  it('leaves the real runner to those two alone, everywhere in src/', () => {
    const calls = tsFiles(SRC).flatMap((rel) => doorCalls(SRC, rel, readFileSync(join(SRC, rel), 'utf8')));
    // The doors are reached from src/ too — if this ever counts zero, the walk has stopped seeing them.
    expect(calls.length).toBeGreaterThan(0);
    const unseamed = calls.filter((call) => !SEAM.test(call.args)).map((call) => `${call.at}  ${call.name}()`);
    expect(
      unseamed,
      `only ${MAY_DEFAULT.join(' and ')} may reach the real Keychain runner:\n${unseamed.join('\n')}`,
    ).toEqual(unseamed.filter((at) => MAY_DEFAULT.some((allowed) => at.startsWith(allowed))));
  });
});
