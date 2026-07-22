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

describe('AuthManager refresh failure path', () => {
  it('propagates the refresh error and does not persist tokens when refresh rejects', async () => {
    const store = fakeStore({ accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() + 1000 });
    const saveSpy = vi.spyOn(store, 'save');
    const refresh = vi.fn().mockRejectedValue(new Error('Token refresh failed: 401'));
    const manager = new AuthManager(store, config, refresh as unknown as typeof import('../../src/auth/oauth-flow.js').refreshAccessToken);

    await expect(manager.getAccessToken()).rejects.toThrow(/refresh failed/i);
    expect(saveSpy).not.toHaveBeenCalled();
    // stale tokens are left in place (documents current behavior: no re-auth reset)
    expect(store.load()).toMatchObject({ refreshToken: 'rt-old' });
  });

  it('single-flights concurrent refreshes: N overlapping calls near expiry spend the token once', async () => {
    const store = fakeStore({ accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() + 1000 });
    let resolveRefresh: (v: { accessToken: string; refreshToken: string; expiresIn: number }) => void = () => {};
    const refresh = vi.fn().mockImplementation(
      () => new Promise((resolve) => { resolveRefresh = resolve; }),
    );
    const manager = new AuthManager(store, config, refresh as unknown as typeof import('../../src/auth/oauth-flow.js').refreshAccessToken);

    // Fire five overlapping calls before any refresh resolves.
    const pending = Promise.all(Array.from({ length: 5 }, () => manager.getAccessToken()));
    resolveRefresh({ accessToken: 'at-new', refreshToken: 'rt-new', expiresIn: 3600 });
    const tokens = await pending;

    expect(tokens).toEqual(Array(5).fill('at-new'));
    // Exactly one refresh; the rotating refresh token is not double-spent.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(config, 'rt-old');
  });

  it('surfaces an actionable re-authorize error when the token store fails to decrypt', async () => {
    const brokenStore = {
      load: () => {
        throw new Error('Unsupported state or unable to authenticate data');
      },
      save: vi.fn(),
      clear: vi.fn(),
    } as unknown as TokenStore;
    const manager = new AuthManager(brokenStore, config, vi.fn() as unknown as typeof import('../../src/auth/oauth-flow.js').refreshAccessToken);

    await expect(manager.getAccessToken()).rejects.toThrow(/re-authorize/i);
  });
});
