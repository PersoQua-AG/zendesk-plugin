import { AuthManager } from './auth-manager.js';
import type { IdentityTokenStore } from './identity-store.js';
import type { OAuthConfig } from './oauth-flow.js';
import type { StoredTokens } from './token-store.js';
import type { TokenProvider } from '../client/token-provider.js';

// Lazily builds and caches one AuthManager per identity, over that identity's own encrypted
// TokenStore. AuthManager already implements single-flight refresh + fail-closed load, so per-user
// isolation reuses all of it — the only new axis is "which file".
export class IdentityAuthResolver {
  private readonly cache = new Map<string, AuthManager>();

  constructor(
    private readonly stores: IdentityTokenStore,
    private readonly config: OAuthConfig,
  ) {}

  forIdentity(identity: string): TokenProvider {
    const existing = this.cache.get(identity);
    if (existing) return existing;
    const manager = new AuthManager(this.stores.storeFor(identity), this.config);
    this.cache.set(identity, manager);
    return manager;
  }

  // Called by the bridge provider right after a successful Zendesk code exchange.
  persist(identity: string, tokens: StoredTokens): void {
    this.stores.storeFor(identity).save(tokens);
    this.cache.delete(identity); // force a fresh AuthManager to pick up the new tokens
  }

  // GDPR erasure primitive (D3/A7): drops the identity's encrypted token file + cached manager.
  // Exercised by identity-resolver.test.ts and referenced by deploy/README's erasure procedure.
  revoke(identity: string): void {
    this.stores.storeFor(identity).clear();
    this.cache.delete(identity);
  }
}
