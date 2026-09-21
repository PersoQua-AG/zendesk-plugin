import { describe, it, expect, vi } from 'vitest';
import { AuthManager } from '../../src/auth/auth-manager.js';
import type { StoredTokens, TokenStore } from '../../src/auth/token-store.js';
import type { OAuthConfig, refreshAccessToken } from '../../src/auth/oauth-flow.js';

const config: OAuthConfig = {
  subdomain: 'acme',
  clientId: 'id',
  clientSecret: 'secret',
  callbackPort: 8976,
  scopes: ['read', 'write'],
};

function fakeStore(initial: StoredTokens | null): TokenStore {
  let current = initial;
  return {
    load: () => current,
    save: (t: StoredTokens) => {
      current = t;
    },
    clear: () => {
      current = null;
    },
  } as unknown as TokenStore;
}

// A Desktop Extension user has no terminal, so "run the OAuth setup flow" is not an instruction
// they can follow. Every unauthorized path must name the tool they can actually call.
describe('actionable authorization messages', () => {
  it('names zendesk_login when no authorization is stored', async () => {
    const manager = new AuthManager(fakeStore(null), config);
    await expect(manager.getAccessToken()).rejects.toThrow(/zendesk_login/);
  });

  it('names zendesk_login when the stored credentials cannot be decrypted', async () => {
    const broken = {
      load: () => {
        throw new Error('Unsupported state or unable to authenticate data');
      },
    } as unknown as TokenStore;
    const manager = new AuthManager(broken, config);
    await expect(manager.getAccessToken()).rejects.toThrow(/zendesk_login/);
    // No crypto/GCM internals reach the user.
    await expect(manager.getAccessToken()).rejects.not.toThrow(/unable to authenticate data/);
  });

  it('names zendesk_login when the refresh grant fails', async () => {
    const store = fakeStore({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() - 1 });
    const refresh = vi.fn().mockRejectedValue(new Error('Token refresh failed: 401 invalid_grant'));
    const manager = new AuthManager(store, config, refresh as unknown as typeof refreshAccessToken);
    await expect(manager.getAccessToken()).rejects.toThrow(/zendesk_login/);
    await expect(manager.getAccessToken()).rejects.toThrow(/refresh failed/i);
  });

  it('refreshes an expired access token silently and asks for NO login (regression)', async () => {
    const store = fakeStore({ accessToken: 'a-old', refreshToken: 'r-old', expiresAt: Date.now() - 1 });
    const refresh = vi
      .fn()
      .mockResolvedValue({ accessToken: 'a-new', refreshToken: 'r-new', expiresIn: 3600 });
    const manager = new AuthManager(store, config, refresh as unknown as typeof refreshAccessToken);
    await expect(manager.getAccessToken()).resolves.toBe('a-new');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
