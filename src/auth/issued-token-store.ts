import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { TokenStore } from './token-store.js';

// Opaque access tokens we issue to claude.ai live for one session window; if the process restarts,
// claude.ai simply re-authorizes (the durable, restart-surviving state is the per-user Zendesk
// token store, not these).
const DEFAULT_TTL_MS = 3_600_000;

interface Pending {
  redirectUri: string;
  expiresAt: number;
}

// Maps our opaque access tokens to a connector identity, encrypted at rest by reusing TokenStore
// verbatim (one AES-256-GCM file per opaque token, filename = sha256(token) so the bearer never
// lands on disk raw). Pending-authorize state (downstream redirect + PKCE challenge) is held
// in-memory, single-use, TTL-bounded — the CSRF/state discipline of the stdio oauth-flow.
export class IssuedTokenStore {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly issuedDir: string,
    private readonly encryptionSecret: string,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  mint(identity: string): string {
    const opaque = randomBytes(32).toString('hex');
    this.fileFor(opaque).save({ accessToken: identity, refreshToken: '', expiresAt: Date.now() + this.ttlMs });
    return opaque;
  }

  // Throws InvalidTokenError (the SDK type requireBearerAuth maps to 401) for an unknown or expired
  // token, so claude.ai gets a clean re-auth signal — never a 500. Never returns a partial identity.
  // expiresAt is epoch-ms (the AuthManager stores the identity in the accessToken field).
  identityFor(token: string): { identity: string; expiresAt: number } {
    const rec = this.fileFor(token).load();
    // Messages are surfaced verbatim in the WWW-Authenticate header, which is latin1-only — keep them
    // ASCII (no em dash) or setHeader throws and the clean 401 degrades back into a 500.
    if (!rec) throw new InvalidTokenError('Unknown access token - re-authorize the Zendesk connector.');
    if (Date.now() >= rec.expiresAt) throw new InvalidTokenError('Access token expired - re-authorize the Zendesk connector.');
    return { identity: rec.accessToken, expiresAt: rec.expiresAt };
  }

  pendingRedirect(state: string, redirectUri: string): void {
    this.evictExpired(); // bound the map: never-consumed (abandoned) authorize states must not accrue.
    this.pending.set(state, { redirectUri, expiresAt: Date.now() + this.ttlMs });
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [state, p] of this.pending) {
      if (now >= p.expiresAt) this.pending.delete(state);
    }
  }

  // Single-use: an unknown, reused, or expired state is refused as possible CSRF.
  consumePendingRedirect(state: string): { redirectUri: string } {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || Date.now() >= p.expiresAt) throw new Error('OAuth state mismatch or expired — possible CSRF.');
    return { redirectUri: p.redirectUri };
  }

  private fileFor(opaque: string): TokenStore {
    const name = createHash('sha256').update(opaque).digest('hex');
    return new TokenStore(join(this.issuedDir, `${name}.enc`), this.encryptionSecret);
  }
}
