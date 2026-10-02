import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from '../../src/auth/token-store.js';

// The mode argument at src/auth/encrypted-file.ts was unprotected: `grep -rn "0o600\|0600" tests/`
// found nothing, so dropping it would have left CI green and the Zendesk credentials of every user
// readable by every other account on the machine.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tokensPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zd-mode-'));
  dirs.push(dir);
  return join(dir, 'tokens.enc');
}

const tokens = { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1 };
const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8);

describe('the token file on disk', () => {
  it('is readable and writable by its owner alone', () => {
    const path = tokensPath();
    new TokenStore(path, 'a-key').save(tokens);
    expect(mode(path)).toBe('600');
  });

  // The mode argument only applies when the write CREATES the file, so a file that is already there
  // — one a local attacker pre-created world-readable in a data directory they can write to — would
  // keep its own mode and receive the credentials anyway.
  it('is tightened even when the file was already there with a wider mode', () => {
    const path = tokensPath();
    writeFileSync(path, '');
    chmodSync(path, 0o666);
    new TokenStore(path, 'a-key').save(tokens);
    expect(mode(path)).toBe('600');
  });
});
