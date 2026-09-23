import { randomBytes } from 'node:crypto';
import { renameSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { OpaqueTokenStore, type OpaqueRecord } from './opaque-token-store.js';

// A presented refresh token that was ALREADY rotated. RFC 6819 §5.2.2.3: with rotation in place,
// a replay is the classic indicator of a stolen chain, so the whole family is revoked. Carries the
// chain so the caller can say what it revoked without re-reading anything.
export class RefreshTokenReplayError extends InvalidTokenError {
  constructor(readonly chainId: string, readonly revoked: number) {
    super('Refresh token was already used - re-authorize the Zendesk connector.');
  }
}

// Downstream refresh tokens: same opaque-token mechanism as the issued access tokens, in its own
// directory with its own TTL, plus the two things a refresh token needs and an access token does
// not — an atomic single-use spend, and rotation-replay detection.
export class RefreshTokenStore extends OpaqueTokenStore {
  // Spend a refresh token exactly once, across processes.
  //
  // The claim is a rename, not a read-then-unlink. rename(2) is atomic on POSIX: of N concurrent
  // callers presenting the same token, exactly ONE moves the file and the rest get ENOENT. A
  // read-check-unlink sequence leaves a window between the read and the unlink, and four processes
  // hitting it in the same millisecond all succeed — measured, which is why this is a rename.
  //
  // Only after winning the claim do we read and validate. The token is spent either way: an expired
  // or corrupt record still leaves a tombstone, because a token that reached this method must never
  // be usable again.
  consume(token: string): OpaqueRecord {
    const claim = `${this.pathFor(token)}.${randomBytes(8).toString('hex')}.claim`;
    try {
      renameSync(this.pathFor(token), claim);
    } catch {
      throw this.refuseUnclaimed(token);
    }
    try {
      const rec = this.readOrRefuse(claim);
      // Tombstone BEFORE returning: if the caller crashes after this, the token is still spent.
      // It expires with the token it replaces, so it costs no retention beyond the original.
      this.write(this.pathFor(token, '.spent'), rec);
      if (Date.now() >= rec.expiresAt) {
        throw new InvalidTokenError('Refresh token expired - re-authorize the Zendesk connector.');
      }
      return rec;
    } finally {
      this.remove(claim);
    }
  }

  // Drop every LIVE token of one rotation family. Returns how many were dropped, so the caller can
  // log a number that carries its own meaning rather than asserting "revoked" with nothing behind it.
  revokeChain(chainId: string): number {
    if (!chainId || !existsSync(this.dir)) return 0;
    let revoked = 0;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.enc')) continue;
      const path = join(this.dir, name);
      try {
        if (this.read(path)?.chainId !== chainId) continue;
      } catch {
        continue; // unreadable: prune's job, not ours — never abort the revocation sweep
      }
      this.remove(path);
      revoked += 1;
    }
    return revoked;
  }

  // The claim failed. Either the token never existed / already expired out of the store, or it was
  // rotated earlier and left a tombstone — and only the second case is evidence of theft.
  private refuseUnclaimed(token: string): InvalidTokenError {
    let spent: OpaqueRecord | null = null;
    try {
      spent = this.read(this.pathFor(token, '.spent'));
    } catch {
      spent = null; // corrupt tombstone proves nothing; fall through to the plain refusal
    }
    if (!spent) return new InvalidTokenError('Unknown refresh token - re-authorize the Zendesk connector.');
    return new RefreshTokenReplayError(spent.chainId, this.revokeChain(spent.chainId));
  }

  // A claimed file that will not decrypt is unrecoverable; the token is already spent by the claim,
  // so refuse it as a token rather than letting a GCM failure escape as something else.
  private readOrRefuse(claim: string): OpaqueRecord {
    let rec: OpaqueRecord | null;
    try {
      rec = this.read(claim);
    } catch {
      rec = null;
    }
    if (!rec) throw new InvalidTokenError('Refresh token is unreadable - re-authorize the Zendesk connector.');
    return rec;
  }
}
