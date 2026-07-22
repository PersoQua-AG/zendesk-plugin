import { describe, it, expect, vi } from 'vitest';
import { AuthManager } from '../../src/auth/auth-manager.js';
import type { TokenStore, StoredTokens } from '../../src/auth/token-store.js';
import type { OAuthConfig } from '../../src/auth/oauth-flow.js';

function fakeStore(initial: StoredTokens | null): TokenStore {
  let current = initial;
  return {
    load: () => current,
    save: (tokens: StoredTokens) => {
      current = tokens;
    },
    clear: () => {
      current = null;
    },
  } as unknown as TokenStore;
}

const config: OAuthConfig = {
  subdomain: 'acme',
  clientId: 'id',
  clientSecret: 'secret',
  callbackPort: 8976,
  scopes: ['read', 'write'],
};

describe('AuthManager', () => {
  it('throws when no tokens have been saved yet', async () => {
    const manager = new AuthManager(fakeStore(null), config);
    await expect(manager.getAccessToken()).rejects.toThrow(/no zendesk authorization/i);
  });

  it('returns the stored access token when not near expiry', async () => {
    const store = fakeStore({ accessToken: 'at-valid', refreshToken: 'rt-1', expiresAt: Date.now() + 60 * 60 * 1000 });
    const refresh = vi.fn();
    const manager = new AuthManager(store, config, refresh as any);
    const token = await manager.getAccessToken();
    expect(token).toBe('at-valid');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes and persists new tokens when close to expiry', async () => {
    const store = fakeStore({ accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() + 1000 });
    const refresh = vi.fn().mockResolvedValue({ accessToken: 'at-new', refreshToken: 'rt-new', expiresIn: 3600 });
    const manager = new AuthManager(store, config, refresh as any);
    const token = await manager.getAccessToken();
    expect(token).toBe('at-new');
    expect(refresh).toHaveBeenCalledWith(config, 'rt-old');
    expect(store.load()).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' });
  });
});
