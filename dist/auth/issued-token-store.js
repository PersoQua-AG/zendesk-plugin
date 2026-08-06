import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { TokenStore } from './token-store.js';
// Opaque access tokens we issue to claude.ai live for one session window; if the process restarts,
// claude.ai simply re-authorizes (the durable, restart-surviving state is the per-user Zendesk
// token store, not these).
const DEFAULT_TTL_MS = 3_600_000;
// Maps our opaque access tokens to a connector identity, encrypted at rest by reusing TokenStore
// verbatim (one AES-256-GCM file per opaque token, filename = sha256(token) so the bearer never
// lands on disk raw). Pending-authorize state (downstream redirect + PKCE challenge) is held
// in-memory, single-use, TTL-bounded — the CSRF/state discipline of the stdio oauth-flow.
export class IssuedTokenStore {
    issuedDir;
    encryptionSecret;
    ttlMs;
    pending = new Map();
    constructor(issuedDir, encryptionSecret, ttlMs = DEFAULT_TTL_MS) {
        this.issuedDir = issuedDir;
        this.encryptionSecret = encryptionSecret;
        this.ttlMs = ttlMs;
    }
    mint(identity) {
        const opaque = randomBytes(32).toString('hex');
        this.fileFor(opaque).save({ accessToken: identity, refreshToken: '', expiresAt: Date.now() + this.ttlMs });
        return opaque;
    }
    // Throws (→ mapped to 401) for an unknown or expired token — never returns a partial identity.
    // expiresAt is epoch-ms (the AuthManager stores the identity in the accessToken field).
    identityFor(token) {
        const rec = this.fileFor(token).load();
        if (!rec)
            throw new Error('Unknown access token — re-authorize the Zendesk connector.');
        if (Date.now() >= rec.expiresAt)
            throw new Error('Access token expired — re-authorize the Zendesk connector.');
        return { identity: rec.accessToken, expiresAt: rec.expiresAt };
    }
    pendingRedirect(state, redirectUri, codeChallenge) {
        this.evictExpired(); // bound the map: never-consumed (abandoned) authorize states must not accrue.
        this.pending.set(state, { redirectUri, codeChallenge, expiresAt: Date.now() + this.ttlMs });
    }
    evictExpired() {
        const now = Date.now();
        for (const [state, p] of this.pending) {
            if (now >= p.expiresAt)
                this.pending.delete(state);
        }
    }
    // Single-use: an unknown, reused, or expired state is refused as possible CSRF.
    consumePendingRedirect(state) {
        const p = this.pending.get(state);
        this.pending.delete(state);
        if (!p || Date.now() >= p.expiresAt)
            throw new Error('OAuth state mismatch or expired — possible CSRF.');
        return { redirectUri: p.redirectUri, codeChallenge: p.codeChallenge };
    }
    fileFor(opaque) {
        const name = createHash('sha256').update(opaque).digest('hex');
        return new TokenStore(join(this.issuedDir, `${name}.enc`), this.encryptionSecret);
    }
}
