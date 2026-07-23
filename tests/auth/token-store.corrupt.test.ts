import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from '../../src/auth/token-store.js';

describe('TokenStore corrupt-input handling', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zd-token-corrupt-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws (does not silently return partial data) when the payload is truncated below iv+authTag length', () => {
    const path = join(dir, 'tokens.enc');
    // 10 bytes base64 -> shorter than the 12-byte IV + 16-byte auth tag prefix.
    writeFileSync(path, Buffer.from('too-short!!').toString('base64'));
    const store = new TokenStore(path, 'secret-key');
    expect(() => store.load()).toThrow();
  });

  it('throws when the auth tag is tampered with (GCM integrity failure)', () => {
    const path = join(dir, 'tokens.enc');
    const store = new TokenStore(path, 'secret-key');
    store.save({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1 });
    // Flip a byte inside the auth-tag region (bytes 12..28) and rewrite.
    const raw = Buffer.from(readFileSync(path, 'utf8'), 'base64');
    raw[13] = raw[13] ^ 0xff;
    writeFileSync(path, raw.toString('base64'));
    expect(() => store.load()).toThrow();
  });
});
