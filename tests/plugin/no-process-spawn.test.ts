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

  it('runs only /usr/bin/security there, with an argument ARRAY and no shell', () => {
    const source = readFileSync(join(SRC, KEY_SOURCE), 'utf8');
    // One call, one binary. execFileSync takes (file, args[]) and starts no shell; exec/execSync
    // would take a command STRING, which is how an argument becomes a command.
    expect(source.match(/execFile(Sync)?\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/\bexec(Sync)?\(|\bspawn(Sync)?\(|\bfork\(|shell:\s*true/);
    expect(source).toContain("const SECURITY_BIN = '/usr/bin/security';");
    // The secret is on stdin, never in argv (#68 B4): `-w` last is what makes security prompt.
    expect(source).toContain("'-U', '-w'], `${value}\\n${value}\\n`");
    expect(source).toMatch(/execFileSync\(bin, args, \{/);
    // …where `bin` defaults to the one binary and is a parameter only so the runner's own outcomes can
    // be measured against /bin/echo and a missing path. No caller in src/ passes it.
    expect(source).toMatch(/bin: string = SECURITY_BIN/);
  });

  it('carries no browser launcher anywhere', () => {
    const offenders = srcFiles().filter((rel) => BROWSER_LAUNCH.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
