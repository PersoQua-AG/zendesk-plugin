import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from '../../src/auth/token-store.js';

describe('TokenStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zd-token-store-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no tokens have been saved', () => {
    const store = new TokenStore(join(dir, 'tokens.enc'), 'secret-key');
    expect(store.load()).toBeNull();
  });

  it('round-trips saved tokens', () => {
    const store = new TokenStore(join(dir, 'tokens.enc'), 'secret-key');
    store.save({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 12345 });
    expect(store.load()).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 12345 });
  });

  it('does not store tokens in plaintext on disk', () => {
    const path = join(dir, 'tokens.enc');
    const store = new TokenStore(path, 'secret-key');
    store.save({ accessToken: 'super-secret-access-token', refreshToken: 'rt-1', expiresAt: 1 });
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('super-secret-access-token');
  });

  it('fails to decrypt with the wrong encryption secret', () => {
    const path = join(dir, 'tokens.enc');
    const store = new TokenStore(path, 'secret-key');
    store.save({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1 });
    const wrongStore = new TokenStore(path, 'wrong-key');
    expect(() => wrongStore.load()).toThrow();
  });

  it('clear() removes any saved tokens', () => {
    const store = new TokenStore(join(dir, 'tokens.enc'), 'secret-key');
    store.save({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1 });
    store.clear();
    expect(store.load()).toBeNull();
  });
});
