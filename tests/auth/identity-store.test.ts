import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityTokenStore } from '../../src/auth/identity-store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function usersDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zd-users-'));
  dirs.push(dir);
  return join(dir, 'users');
}

const tokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 };

describe('IdentityTokenStore', () => {
  it('writes one distinct hashed file per identity, never the raw identity', () => {
    const dir = usersDir();
    const stores = new IdentityTokenStore(dir, 'server-secret');
    stores.storeFor('alice@persoqua.de').save(tokens);
    stores.storeFor('bob@persoqua.de').save(tokens);

    const files = readdirSync(dir);
    expect(files).toHaveLength(2);
    for (const f of files) {
      expect(f).toMatch(/^[0-9a-f]{64}\.enc$/);
      expect(f).not.toContain('alice');
      expect(f).not.toContain('bob');
      expect(f).not.toContain('persoqua');
    }
  });

  it('isolates identities: B cannot read A tokens', () => {
    const dir = usersDir();
    const stores = new IdentityTokenStore(dir, 'server-secret');
    stores.storeFor('A').save(tokens);
    expect(stores.storeFor('B').load()).toBeNull();
    expect(stores.storeFor('A').load()).toEqual(tokens);
  });

  it('fails closed when the encryption secret is rotated (GCM integrity)', () => {
    const dir = usersDir();
    new IdentityTokenStore(dir, 'old-secret').storeFor('A').save(tokens);
    // A different server key must not decrypt — throws rather than leaking plaintext.
    expect(() => new IdentityTokenStore(dir, 'new-secret').storeFor('A').load()).toThrow();
  });
});
