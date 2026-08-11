import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityTokenStore } from '../../src/auth/identity-store.js';
import { IdentityAuthResolver } from '../../src/auth/identity-resolver.js';
import type { OAuthConfig } from '../../src/auth/oauth-flow.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const config: OAuthConfig = {
  subdomain: 'acme',
  clientId: 'cid',
  clientSecret: 'server-secret',
  callbackPort: 8976,
  scopes: ['read', 'write'],
};

function resolver(): IdentityAuthResolver {
  const dir = mkdtempSync(join(tmpdir(), 'zd-res-'));
  dirs.push(dir);
  return new IdentityAuthResolver(new IdentityTokenStore(join(dir, 'users'), config.clientSecret), config);
}

describe('IdentityAuthResolver', () => {
  it('caches one AuthManager per identity', () => {
    const r = resolver();
    const first = r.forIdentity('A');
    expect(r.forIdentity('A')).toBe(first);
    expect(r.forIdentity('B')).not.toBe(first);
  });

  it('persist stores tokens and forIdentity then serves them', async () => {
    const r = resolver();
    r.persist('A', { accessToken: 'fresh-token', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 });
    await expect(r.forIdentity('A').getAccessToken()).resolves.toBe('fresh-token');
  });

  it('persist invalidates the cached manager so new tokens are picked up', () => {
    const r = resolver();
    const before = r.forIdentity('A');
    r.persist('A', { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 3_600_000 });
    expect(r.forIdentity('A')).not.toBe(before);
  });

  it('revoke clears the token file and cache; a later token needs re-auth', async () => {
    const r = resolver();
    r.persist('A', { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 3_600_000 });
    r.revoke('A');
    await expect(r.forIdentity('A').getAccessToken()).rejects.toThrow(/No Zendesk authorization found/);
  });
});
