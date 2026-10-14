// tests/plugin/no-process-spawn.test.ts
// Decision D3, as a guard rather than a sentence in a plan: nothing in src/ opens a browser, and the
// automatic login answers with the URL instead. The reason is not attack surface — `open` would start
// a browser wherever the SERVER runs, which in Cowork may be a VM nobody is looking at, while a
// person who clicks always clicks on their own device, in their own browser, with their own Zendesk
// session.
//
// There is exactly ONE sanctioned child process in the tree, and it is named here: the macOS Keychain
// has no in-process API from node, so src/auth/store-key.ts runs /usr/bin/security. That is what the
// allowlist below is for, and the second case pins that this file runs nothing else.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const SRC = join(process.cwd(), 'src');
const KEY_SOURCE = 'auth/store-key.ts';

const CHILD_PROCESS = /child_process/;
// What a browser launcher looks like on each platform, plus the npm packages that wrap one. Narrow on
// purpose: a bare `open` is a Zendesk ticket status all over src/register, so what is matched is the
// COMMAND form and the import form, which is what a launcher actually needs.
const BROWSER_LAUNCH =
  /xdg-open|\bopen\s+-a\b|start\s+""|rundll32|(?:from|require\()\s*['"](?:open|opn|opener|openurl)['"]/;

function srcFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map((p) => String(p).split('\\').join('/'))
    .filter((p) => p.endsWith('.ts'));
}

describe('nothing spawns a process to open a browser', () => {
  it('names child_process in exactly one file, the Keychain key source', () => {
    const mentions = srcFiles().filter((rel) => CHILD_PROCESS.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(mentions).toEqual([KEY_SOURCE]);
  });

  it('runs only /usr/bin/security there, with an argument ARRAY, no shell, and the secret on stdin', async () => {
    // Asked of what the file CALLS, not of how it is spelled: every export of child_process is replaced
    // on the one object that `import`, `import()`, `require` and `createRequire` all resolve to, and
    // syncBuiltinESMExports pushes it into the ESM bindings. process.binding — the way past that object
    // to spawn_sync and process_wrap — is closed for the same window. So any route to a spawn is
    // recorded, and none reaches the real /usr/bin/security.
    const cp = createRequire(import.meta.url)('node:child_process') as Record<string, unknown>;
    const real = { ...cp };
    const proc = process as unknown as { binding: (name: string) => unknown };
    const realBinding = proc.binding;
    const bindings: string[] = [];
    const calls: { name: string; file: unknown; args: unknown; options: unknown }[] = [];

    // One Keychain answer, spoken in the shape of each synchronous runner, so swapping one for the other
    // stays green. A key-shaped canary that no argv can carry by accident.
    const KEY = 'T8canaryT8canaryT8canaryT8canaryT8canaryT8canary';
    type Answer = { status?: number; code?: string; output?: string };
    let answer: Answer = {};
    const refused = ({ status, code }: Answer) => Object.assign(new Error('refused'), { status, code });
    const fakes: Record<string, (a: Answer) => unknown> = {
      execFileSync: (a) => {
        if (a.output === undefined) throw refused(a);
        return a.output;
      },
      spawnSync: (a) => ({ status: a.status ?? null, stdout: a.output ?? '', error: a.code ? refused(a) : undefined }),
    };
    for (const name of Object.keys(real)) {
      if (typeof real[name] !== 'function') continue;
      // `function`, not an arrow: `new ChildProcess()` must be recorded too, before anything can throw.
      cp[name] = function (file: unknown, args?: unknown, options?: unknown) {
        calls.push({ name, file, args, options });
        const fake = fakes[name];
        if (!fake) throw new Error(`${name} is not faked`);
        return fake(answer);
      };
    }
    syncBuiltinESMExports();
    proc.binding = (name) => {
      bindings.push(name);
      throw new Error(`process.binding('${name}') refused`);
    };

    const values = {
      ZENDESK_SUBDOMAIN: 'canary-subdomain-t8',
      ZENDESK_OAUTH_CLIENT_ID: 'canary-client-id-t8',
      ZENDESK_OAUTH_CLIENT_SECRET: 'canary-client-secret-t8',
    };
    const settled: unknown[] = [];
    try {
      // Both doors are shut before the module under test is loaded at all.
      expect((await import('node:child_process')).execFileSync).toBe(cp.execFileSync);
      expect(() => proc.binding('spawn_sync')).toThrow(/refused/);
      bindings.length = 0;
      const key = await import('../../src/auth/store-key.js');
      // Not found, denied, no binary, killed by a signal, and a stored key.
      for (answer of [{ status: 44 }, { status: 1 }, { code: 'ENOENT' }, {}, { status: 0, output: KEY }]) {
        for (const run of [key.resolveTokenStoreKey, key.readKeychainConfig, () => key.writeKeychainConfig(values)]) {
          try {
            settled.push(run());
          } catch (err) {
            settled.push((err as Error).message);
          }
        }
      }
    } finally {
      Object.assign(cp, real);
      syncBuiltinESMExports();
      proc.binding = realBinding;
    }

    expect(bindings).toEqual([]);
    for (const call of calls) {
      expect(call.file).toBe('/usr/bin/security');
      expect(Array.isArray(call.args)).toBe(true);
      expect((call.options as { shell?: unknown }).shell).toBeFalsy();
    }
    // The secret is on stdin, never in argv (#68 B4): `-w` last is what makes security prompt. Checked
    // as a SUBSTRING of every element, so `v=${value}` hides nothing either.
    const adds = calls.filter((c) => (c.args as string[])[0] === 'add-generic-password');
    expect(adds.length).toBeGreaterThan(0);
    const secrets = [KEY, ...Object.values(values)];
    for (const { args, options } of adds) {
      const { input } = options as { input: string };
      const value = input.split('\n')[0];
      expect(value).not.toBe('');
      expect(input).toBe(`${value}\n${value}\n`);
      expect((args as string[]).at(-1)).toBe('-w');
      secrets.push(value);
    }
    for (const call of calls) {
      for (const arg of call.args as string[]) {
        for (const secret of secrets) expect(arg).not.toContain(secret);
      }
    }
    // And each answer led where it should, so a spawn that throws cannot hide in a swallowed error.
    const read = expect.stringMatching(/could not be read/);
    const written = expect.stringMatching(/could not be written/);
    const platform = expect.stringMatching(/this is not macOS/);
    const stored = { ZENDESK_SUBDOMAIN: KEY, ZENDESK_OAUTH_CLIENT_ID: KEY, ZENDESK_OAUTH_CLIENT_SECRET: KEY };
    expect(settled).toEqual([
      written, {}, written, // not found
      read, read, written, // denied
      platform, {}, platform, // no binary
      read, read, written, // signal
      KEY, stored, expect.stringMatching(/did not keep/), // stored key
    ]);
  });

  it('carries no browser launcher anywhere', () => {
    const offenders = srcFiles().filter((rel) => BROWSER_LAUNCH.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
