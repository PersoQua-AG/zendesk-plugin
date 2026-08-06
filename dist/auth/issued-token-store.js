import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { readdirSync, unlinkSync, existsSync } from 'node:fs';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { TokenStore } from './token-store.js';
// Opaque access tokens we issue to claude.ai live for one session window; if the process restarts,
// claude.ai simply re-authorizes (the durable, restart-surviving state is the per-user Zendesk
// token store, not these).
const DEFAULT_TTL_MS = 3_600_000;
// Bound the in-memory authorize map: abandoned (never-consumed) states are TTL-evicted, but a flood
// faster than the TTL must not grow unbounded — evict oldest past this hard cap.
const MAX_PENDING = 10_000;
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
    // Unlink issued-token files whose decrypted expiresAt is past, so hourly re-auth can't grow the
    // issued/ dir without bound (H2). Call at startup and on the same daily timer as audit.prune().
    // A torn/corrupt file is skipped (never aborts the sweep), mirroring audit.prune().
    prune(now = Date.now()) {
        if (!existsSync(this.issuedDir))
            return;
        for (const name of readdirSync(this.issuedDir)) {
            if (!name.endsWith('.enc'))
                continue;
            const path = join(this.issuedDir, name);
            try {
                const rec = new TokenStore(path, this.encryptionSecret).load();
                if (!rec || now >= rec.expiresAt)
                    unlinkSync(path);
            }
            catch {
                // Torn/corrupt file (e.g. crash mid-write): skip, never abort the sweep.
            }
        }
    }
    // Throws InvalidTokenError (the SDK type requireBearerAuth maps to 401) for an unknown or expired
    // token, so claude.ai gets a clean re-auth signal — never a 500. Never returns a partial identity.
    // expiresAt is epoch-ms (the AuthManager stores the identity in the accessToken field).
    identityFor(token) {
        const rec = this.fileFor(token).load();
        // Messages are surfaced verbatim in the WWW-Authenticate header, which is latin1-only — keep them
        // ASCII (no em dash) or setHeader throws and the clean 401 degrades back into a 500.
        if (!rec)
            throw new InvalidTokenError('Unknown access token - re-authorize the Zendesk connector.');
        if (Date.now() >= rec.expiresAt)
            throw new InvalidTokenError('Access token expired - re-authorize the Zendesk connector.');
        return { identity: rec.accessToken, expiresAt: rec.expiresAt };
    }
    // Keyed by state, with the client_id recorded so the pending record is bound to the client that
    // opened it (M4). We key by state (not the composite (client_id, state)) because the upstream
    // callback carries only state back — a 128-bit state is unguessable, and any live-state reuse is
    // refused below as CSRF/collision rather than silently overwritten.
    pendingRedirect(clientId, state, redirectUri) {
        this.evictExpired(); // bound the map: never-consumed (abandoned) authorize states must not accrue.
        const existing = this.pending.get(state);
        if (existing && Date.now() < existing.expiresAt) {
            throw new Error('Duplicate or colliding authorize state — possible CSRF.');
        }
        if (this.pending.size >= MAX_PENDING) {
            const oldest = this.pending.keys().next().value; // insertion order → oldest first
            if (oldest !== undefined)
                this.pending.delete(oldest);
        }
        this.pending.set(state, { clientId, redirectUri, expiresAt: Date.now() + this.ttlMs });
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
        return { redirectUri: p.redirectUri };
    }
    fileFor(opaque) {
        const name = createHash('sha256').update(opaque).digest('hex');
        return new TokenStore(join(this.issuedDir, `${name}.enc`), this.encryptionSecret);
    }
}
