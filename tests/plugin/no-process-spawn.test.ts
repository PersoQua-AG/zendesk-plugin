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
import { fenceProcesses } from './process-fence.js';

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
    // Asked of what the file CALLS, not of how it is spelled: tests/plugin/process-fence.ts routes every
    // child_process export here and refuses the routes around it, so any spawn is recorded or refused.
    // Each run is answered from a script, one answer per call and the last one repeated, so every branch of
    // runSecurity, writeKeychainConfig and rollback runs and a spawn hidden in one of them is seen.
    const calls: { name: string; file: unknown; args: unknown; options: unknown }[] = [];
    // A key-shaped canary that no argv can carry by accident.
    const KEY = 'T8canaryT8canaryT8canaryT8canaryT8canaryT8canary';
    type Answer = { status?: number; code?: string; output?: string };
    let script: Answer[] = [];
    const refused = ({ status, code }: Answer) => Object.assign(new Error('refused'), { status, code });
    // In the shape of each synchronous runner, so swapping one for the other stays green.
    const fakes: Record<string, (a: Answer) => unknown> = {
      execFileSync: (a) => {
        if (a.output === undefined) throw refused(a);
        return a.output;
      },
      spawnSync: (a) => ({ status: a.status ?? null, stdout: a.output ?? '', error: a.code ? refused(a) : undefined }),
    };
    const { opened, restore } = await fenceProcesses((name, file, args, options) => {
      calls.push({ name, file, args, options });
      const fake = fakes[name];
      if (!fake) throw new Error(`${name} is not faked`);
      return fake((script.length > 1 ? script.shift() : script[0]) as Answer);
    });

    // No 8-character run of these may share one with an argv word such as "oauth-client-secret".
    const values = {
      ZENDESK_SUBDOMAIN: 'qz7Kp2Wm-T8-sub',
      ZENDESK_OAUTH_CLIENT_ID: 'vX4nR8Lc-T8-cid',
      ZENDESK_OAUTH_CLIENT_SECRET: 'hJ3tY6Bq-T8-sec',
    };
    const settled: unknown[] = [];
    const settle = (answers: Answer[], run: () => unknown) => {
      script = answers;
      try {
        settled.push(run());
      } catch (err) {
        settled.push((err as Error).message);
      }
    };
    try {
      const key = await import('../../src/auth/store-key.js');
      const write = () => key.writeKeychainConfig(values);
      // Not found, denied, no binary, killed by a signal, and a stored key.
      for (const answer of [{ status: 44 }, { status: 1 }, { code: 'ENOENT' }, {}, { status: 0, output: KEY }]) {
        for (const run of [key.resolveTokenStoreKey, key.readKeychainConfig, write]) settle([answer], run);
      }
      settle([{ status: 0, output: 'weak' }], key.resolveTokenStoreKey);
      settle([{ status: 0, output: ' \n' }], key.readKeychainConfig);
      // A partial write, rolled back; then one whose delete fails.
      settle([{ status: 0, output: '' }, { status: 1 }, { status: 0, output: '' }], write);
      settle([{ status: 0, output: '' }, { status: 1 }], write);
    } finally {
      restore();
    }

    expect(opened).toEqual([]);
    for (const call of calls) {
      expect(call.file).toBe('/usr/bin/security');
      expect(Array.isArray(call.args)).toBe(true);
      expect((call.options as { shell?: unknown }).shell).toBeFalsy();
    }
    // The secret is on stdin, never in argv (#68 B4): `-w` last is what makes security prompt.
    const adds = calls.filter((c) => (c.args as string[])[0] === 'add-generic-password');
    expect(adds.length).toBeGreaterThan(0);
    const secrets = [KEY, ...Object.values(values)];
    for (const { args, options } of adds) {
      const input = String((options as { input?: unknown }).input);
      const value = input.split('\n')[0];
      expect(value).not.toBe('');
      expect(input).toBe(`${value}\n${value}\n`);
      expect((args as string[]).at(-1)).toBe('-w');
      secrets.push(value);
    }
    // Nor any 8-character run of it, plain, hex or base64 at each of the three alignments.
    const runs = (s: string) => Array.from({ length: s.length - 7 }, (_, i) => s.slice(i, i + 8));
    const forms = (s: string) => [s, Buffer.from(s).toString('hex'), ...[0, 1, 2].map((i) => Buffer.from(s.slice(i)).toString('base64'))];
    const needles = secrets.flatMap((s) => forms(s).flatMap(runs));
    expect(calls.flatMap((c) => (c.args as string[]).filter((arg) => needles.some((n) => arg.includes(n))))).toEqual([]);
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
      expect.stringMatching(/fewer than 32 bytes/), // weak key
      {}, // whitespace-only item
      expect.stringMatching(/could not be written.*Nothing was left behind/),
      expect.stringMatching(/could not be removed again/),
    ]);
  });

  it('carries no browser launcher anywhere', () => {
    const offenders = srcFiles().filter((rel) => BROWSER_LAUNCH.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
