import { OpaqueTokenStore } from './opaque-token-store.js';

// Opaque access tokens we issue to claude.ai live for one session window; if the process restarts,
// claude.ai simply re-authorizes (the durable, restart-surviving state is the per-user Zendesk
// token store, not these).
const DEFAULT_TTL_MS = 3_600_000;
// Bound the in-memory authorize map: abandoned (never-consumed) states are TTL-evicted, but a flood
// faster than the TTL must not grow unbounded — evict oldest past this hard cap.
const MAX_PENDING = 10_000;

interface Pending {
  redirectUri: string;
  expiresAt: number;
}

// The access-token role of OpaqueTokenStore: mint on a completed Zendesk exchange, verify on every
// MCP request. It owns one thing no other role does — the pending-authorize state (the downstream
// redirect keyed by the anti-CSRF state), held in-memory, single-use, TTL-bounded, mirroring the
// CSRF discipline of the stdio oauth-flow.
export class IssuedTokenStore extends OpaqueTokenStore {
  private readonly pending = new Map<string, Pending>();

  constructor(issuedDir: string, encryptionSecret: string, ttlMs: number = DEFAULT_TTL_MS) {
    super(issuedDir, encryptionSecret, ttlMs);
  }

  // Single-use anti-CSRF state → downstream-redirect map. NOT client-bound: the upstream Zendesk
  // callback carries no client identity, so binding to the authorizing client cannot be enforced
  // there. What IS enforced: a 128-bit unguessable state, single-use consume, and refusal of any
  // live-state reuse as CSRF/collision (rather than a silent overwrite).
  pendingRedirect(state: string, redirectUri: string): void {
    this.evictExpired(); // bound the map: never-consumed (abandoned) authorize states must not accrue.
    const existing = this.pending.get(state);
    if (existing && Date.now() < existing.expiresAt) {
      throw new Error('Duplicate or colliding authorize state — possible CSRF.');
    }
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value; // insertion order → oldest first
      if (oldest !== undefined) this.pending.delete(oldest);
    }
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
}
