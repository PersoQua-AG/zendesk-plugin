import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IssuedTokenStore } from '../../src/auth/issued-token-store.js';

const SECRET = 'test-secret';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function issuedDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-issued-'));
  dirs.push(dataDir);
  return join(dataDir, 'issued');
}

function count(dir: string): number {
  return readdirSync(dir).filter((n) => n.endsWith('.enc')).length;
}

describe('IssuedTokenStore.prune (H2)', () => {
  it('unlinks expired files, keeps valid ones, removes corrupt ones', () => {
    const dir = issuedDir();
    // Expired: negative TTL → expiresAt in the past.
    new IssuedTokenStore(dir, SECRET, -1_000).mint('zendesk:expired');
    // Valid: long TTL.
    const valid = new IssuedTokenStore(dir, SECRET, 3_600_000);
    valid.mint('zendesk:valid');
    // Corrupt: a .enc file that does not decrypt.
    writeFileSync(join(dir, 'garbage.enc'), 'not-a-valid-ciphertext');
    expect(count(dir)).toBe(3);

    valid.prune();

    const remaining = readdirSync(dir).filter((n) => n.endsWith('.enc'));
    expect(remaining).not.toContain('garbage.enc'); // corrupt is unrecoverable → unlinked (H2)
    expect(remaining).toHaveLength(1); // only the valid token survives
  });

  it('rejects a duplicate live pending authorize state (single-use CSRF discipline)', () => {
    const store = new IssuedTokenStore(issuedDir(), SECRET);
    store.pendingRedirect('st', 'https://claude.ai/cb');
    expect(() => store.pendingRedirect('st', 'https://claude.ai/cb')).toThrow(/CSRF|colliding/i);
  });
});
