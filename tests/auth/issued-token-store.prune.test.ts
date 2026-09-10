import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
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

  it('finishes the sweep when an unreadable entry also refuses to be unlinked', () => {
    const dir = issuedDir();
    const store = new IssuedTokenStore(dir, SECRET, -1_000);
    store.mint('zendesk:expired');
    // A .enc path that neither decrypts nor unlinks — the "cannot remove it after all" race a
    // concurrent sweep produces, reproduced deterministically as a directory.
    mkdirSync(join(dir, 'wedged.enc'));

    expect(() => store.prune()).not.toThrow();

    const remaining = readdirSync(dir).filter((n) => n.endsWith('.enc'));
    // The wedged entry stays, but it did not stop the expired token from being reaped.
    expect(remaining).toEqual(['wedged.enc']);
  });

  it('leaves files it did not write alone', () => {
    const dir = issuedDir();
    const store = new IssuedTokenStore(dir, SECRET, 3_600_000);
    store.mint('zendesk:valid');
    writeFileSync(join(dir, 'README.txt'), 'not ours');

    store.prune();

    expect(readdirSync(dir)).toContain('README.txt');
    expect(count(dir)).toBe(1);
  });

  it('evicts an expired pending authorize state instead of keeping it forever', () => {
    const store = new IssuedTokenStore(issuedDir(), SECRET, -1_000); // already expired on insert
    store.pendingRedirect('st', 'https://claude.ai/cb');
    // The next authorize sweeps it out, so the same state is no longer a "duplicate live state".
    expect(() => store.pendingRedirect('st', 'https://claude.ai/cb')).not.toThrow();
  });

  it('caps the pending authorize map so a flood cannot grow it without bound (H2)', () => {
    const store = new IssuedTokenStore(issuedDir(), SECRET);
    // One past the hard cap of 10_000: the oldest state is evicted, the newest survives.
    for (let i = 0; i <= 10_000; i++) store.pendingRedirect(`st-${i}`, `https://claude.ai/cb/${i}`);

    expect(() => store.consumePendingRedirect('st-0')).toThrow(/CSRF/i);
    expect(store.consumePendingRedirect('st-10000')).toEqual({ redirectUri: 'https://claude.ai/cb/10000' });
  });

  it('rejects a duplicate live pending authorize state (single-use CSRF discipline)', () => {
    const store = new IssuedTokenStore(issuedDir(), SECRET);
    store.pendingRedirect('st', 'https://claude.ai/cb');
    expect(() => store.pendingRedirect('st', 'https://claude.ai/cb')).toThrow(/CSRF|colliding/i);
  });
});
