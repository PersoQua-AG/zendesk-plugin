import { AuthManager } from './auth-manager.js';
// Lazily builds and caches one AuthManager per identity, over that identity's own encrypted
// TokenStore. AuthManager already implements single-flight refresh + fail-closed load, so per-user
// isolation reuses all of it — the only new axis is "which file".
export class IdentityAuthResolver {
    stores;
    config;
    cache = new Map();
    constructor(stores, config) {
        this.stores = stores;
        this.config = config;
    }
    forIdentity(identity) {
        const existing = this.cache.get(identity);
        if (existing)
            return existing;
        const manager = new AuthManager(this.stores.storeFor(identity), this.config);
        this.cache.set(identity, manager);
        return manager;
    }
    // Called by the bridge provider right after a successful Zendesk code exchange.
    persist(identity, tokens) {
        this.stores.storeFor(identity).save(tokens);
        this.cache.delete(identity); // force a fresh AuthManager to pick up the new tokens
    }
    // GDPR erasure primitive (D3/A7): drops the identity's encrypted token file + cached manager.
    // Exercised by identity-resolver.test.ts and referenced by deploy/README's erasure procedure.
    revoke(identity) {
        this.stores.storeFor(identity).clear();
        this.cache.delete(identity);
    }
}
