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
    // syncBuiltinESMExports pushes it into the ESM bindings. Any route to any spawn is recorded, none
    // reaches the real /usr/bin/security, and exit 44 ("not found") drives the find, add and rollback
    // paths. ponytail: process.binding('spawn_sync') bypasses the object; a spawn in a branch exit 44
    // never reaches goes unseen.
    const cp = createRequire(import.meta.url)('node:child_process') as Record<string, unknown>;
    const real = { ...cp };
    const calls: { name: string; file: unknown; args: unknown; options: unknown }[] = [];
    for (const name of Object.keys(real)) {
      if (typeof real[name] !== 'function') continue;
      cp[name] = (file: unknown, args?: unknown, options?: unknown) => {
        calls.push({ name, file, args, options });
        throw Object.assign(new Error('not found'), { status: 44 });
      };
    }
    syncBuiltinESMExports();
    try {
      expect((await import('node:child_process')).execFileSync).toBe(cp.execFileSync);
      const key = await import('../../src/auth/store-key.js');
      expect(() => key.resolveTokenStoreKey()).toThrow(/could not be written/);
      expect(key.readKeychainConfig()).toEqual({});
      const values = { ZENDESK_SUBDOMAIN: 's', ZENDESK_OAUTH_CLIENT_ID: 'i', ZENDESK_OAUTH_CLIENT_SECRET: 'x' };
      expect(() => key.writeKeychainConfig(values)).toThrow(/could not be written/);
    } finally {
      Object.assign(cp, real);
      syncBuiltinESMExports();
    }

    for (const call of calls) {
      expect(call.name).toBe('execFileSync');
      expect(call.file).toBe('/usr/bin/security');
      expect(Array.isArray(call.args)).toBe(true);
      expect((call.options as { shell?: unknown }).shell).toBeFalsy();
    }
    // The secret is on stdin, never in argv (#68 B4): `-w` last is what makes security prompt.
    const adds = calls.filter((c) => (c.args as string[])[0] === 'add-generic-password');
    expect(adds.length).toBe(2);
    for (const { args, options } of adds) {
      const value = (options as { input: string }).input.split('\n')[0];
      expect(value).not.toBe('');
      expect((options as { input: string }).input).toBe(`${value}\n${value}\n`);
      expect(args).not.toContain(value);
      expect((args as string[]).at(-1)).toBe('-w');
    }
  });

  it('carries no browser launcher anywhere', () => {
    const offenders = srcFiles().filter((rel) => BROWSER_LAUNCH.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
