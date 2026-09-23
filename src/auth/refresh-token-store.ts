import { randomBytes } from 'node:crypto';
import { renameSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { EncryptedFile } from './encrypted-file.js';
import { OpaqueTokenStore, SUFFIX_SPENT, type OpaqueRecord } from './opaque-token-store.js';

// A presented refresh token that was ALREADY rotated. RFC 6819 §5.2.2.3: with rotation in place, a
// replay is the classic indicator of a stolen chain, so the whole family is revoked. `revoked` is
// how many live tokens that actually cost — a chain holds at most one, so it is 0 or 1, and the
// caller logs the number instead of asserting "revoked" with nothing behind it.
export class RefreshTokenReplayError extends InvalidTokenError {
  constructor(
    readonly chainId: string,
    readonly revoked: number,
    readonly alreadyDead: boolean,
  ) {
    super('Refresh token was already used - re-authorize the Zendesk connector.');
  }
}

export interface RefreshRecord extends OpaqueRecord {
  chainId: string;
}

// What a spend leaves behind. `spentAt` is what separates "somebody else is spending this right
// now" from "this token was spent and rotated long ago" — two events the store used to treat
// identically, which cost every concurrent or retried refresh its whole session.
export interface Tombstone extends RefreshRecord {
  spentAt: number;
}

// The answer the first spend produced, kept just long enough for a client to ask again. It is a
// stored constant, not a path back to whatever is live now: it can only ever name what that one
// spend returned, and it expires on its own.
interface RepeatRecord {
  payload: string;
  clientId: string;
  expiresAt: number;
}

export type SpendOutcome =
  | { kind: 'spent'; record: RefreshRecord }
  // chainId rides along so the caller can revoke on a client mismatch without a second lookup. It
  // comes from the TOMBSTONE, the same record the head check above used — not from the receipt,
  // which would be a second, divergeable copy of the same fact.
  | { kind: 'repeat'; payload: string; clientId: string; chainId: string };

// A concurrent presentation of the same token: another process holds the claim and is mid-spend.
// This is NOT a theft signal, and answering it with a revocation is what killed the winner's
// session too.
export class RefreshInFlightError extends InvalidTokenError {
  constructor() {
    super('Refresh already in progress for this token - retry shortly.');
  }
}

// The head of one rotation family. A chain has exactly ONE live token at any instant, so the head
// needs only to name it — which turns revocation from a scan into a lookup.
export interface ChainHead {
  liveHash: string; // sha256 of the currently live refresh token, '' when the chain has none
  dead: boolean;
  expiresAt: number; // absolute end of the chain; every member and tombstone shares it
}

const SUFFIX_CHAIN = '.chain';
// A claim exists only for the microseconds between winning the rename and finishing the spend.
// Anything older is the residue of a process that died mid-spend, and is safe to sweep: a live
// spend can never be this old, so sweeping cannot disturb the rename's race-freeness.
const CLAIM_STALE_MS = 60_000;
// How long the first spend's answer stays repeatable. This is the time a CLIENT needs to notice a
// lost response and retry — a proxy timeout, a mobile handover, a reconnect after standby — not
// time granted to a thief. Seconds, deliberately: within it a stolen token replayed against a live
// chain receives the same pair the legitimate client got, which is the accepted cost of an
// idempotent token endpoint (RFC 6749 §5.1 clients retry; RFC 6819 §5.2.2.3 detection resumes the
// moment the window closes).
const REPEAT_GRACE_MS = 10_000;
const SUFFIX_REPEAT = '.repeat';
const SUFFIX_CLAIM = '.claim';
// `<sha256 of the token>` + this + `<nonce>` + `.claim` — the one place the claim name is defined.
const CLAIM_INFIX = '.enc.';

// Downstream refresh tokens: the opaque-token mechanism in its own directory with its own TTL, plus
// the three things a refresh token needs and an access token does not — an atomic single-use spend,
// rotation-replay detection, and revocation of the family a replayed token belongs to.
//
// Revocation follows the CHAIN, never the directory. The earlier design swept every file to find a
// family whose maximum yield is one token; at 20 001 entries that cost 746 ms of synchronous
// decryption per replay, on an unauthenticated path, repeatable for the same burnt token. The chain
// head makes both the revocation and every subsequent replay O(1).
export class RefreshTokenStore extends OpaqueTokenStore {
  // Starts a NEW family: a fresh login, unrelated to any existing chain. The chain's expiry is
  // ABSOLUTE — rotation renews the token, never the family's deadline. That is what keeps the
  // evidence and the chain alive for exactly the same span (a tombstone that expires before the
  // chain it guards would let a stolen token come back undetected) while still bounding the
  // directory, since nothing in a family outlives the family.
  mint(identity: string, clientId = ''): string {
    const chainId = randomBytes(16).toString('hex');
    const expiresAt = Date.now() + this.ttlMs;
    return this.link({ identity, clientId, chainId, expiresAt }, chainId, expiresAt);
  }

  // Rotation: same family, same deadline, new token. A dead or unverifiable family does not rotate
  // — the successor would be a token no head vouches for, which is exactly what consume() refuses.
  rotate(previous: RefreshRecord, clientId: string): string {
    const head = this.readChainSafely(previous.chainId);
    if (!head || head.dead) {
      throw new InvalidTokenError('Refresh chain is closed - re-authorize the Zendesk connector.');
    }
    return this.link({ ...previous, clientId }, previous.chainId, previous.expiresAt);
  }

  // Writes the head FIRST, then the record it names.
  //
  // The order is the whole point. Two writes cannot be made one, so the question is only which
  // half-finished state a crash leaves behind. Record-then-head leaves a LIVE record that no head
  // names: an orphan that outlives its family and that revocation can never find. Head-then-record
  // leaves a head naming a record that does not exist: a refusal. Fail-closed is the direction an
  // auth surface takes, so the deadlier half is written first.
  private link(rec: RefreshRecord, chainId: string, expiresAt: number): string {
    const token = randomBytes(32).toString('hex');
    this.writeChain(chainId, { liveHash: this.hash(token), dead: false, expiresAt });
    this.write(this.pathFor(token), rec);
    return token;
  }

  // Spend a refresh token exactly once, across processes.
  //
  // The claim is a rename, not a read-then-unlink. rename(2) is atomic on POSIX: of N concurrent
  // callers presenting the same token, exactly ONE moves the file and the rest get ENOENT. A
  // read-check-unlink sequence leaves a window between the read and the unlink; eight processes
  // hitting it in the same millisecond produced two winners — measured, which is why this is a
  // rename.
  consume(token: string): SpendOutcome {
    const live = this.pathFor(token);
    // Expiry is judged BEFORE anything is destroyed. A clock that jumps past the family deadline
    // and is then corrected would otherwise burn an honest user's token and, on their retry,
    // revoke their chain for a replay they never committed.
    const preview = this.readSafely(live);
    if (preview && Date.now() >= preview.expiresAt) {
      throw new InvalidTokenError('Refresh token expired - re-authorize the Zendesk connector.');
    }
    const claim = this.claimPath(this.hash(token), randomBytes(8).toString('hex'));
    try {
      renameSync(live, claim);
    } catch {
      return this.afterClaimFailed(token);
    }
    try {
      const rec = this.readOrRefuse(claim);
      try {
        // Tombstone BEFORE anything else can refuse: if the caller crashes after this, the token is
        // still spent, and a later replay is still recognisable as a replay rather than as unknown.
        this.writeTombstone(token, { ...rec, spentAt: Date.now() });
      } catch (err: unknown) {
        // The tombstone could not be written (ENOSPC). The token is already destroyed by the claim,
        // so the grant fails closed either way; what would be lost is the EVIDENCE. Kill the chain
        // outright instead, so the family cannot be used even though this one replay will later
        // read as "unknown".
        this.killChain(rec.chainId);
        throw err;
      }
      // FAIL-CLOSED MEMBERSHIP. This is the inversion the torn-head finding forced: revocation used
      // to have to FIND the stolen successor, so every way a head could lose the truth — emptied,
      // garbled, deleted, or holding a foreign plaintext — left that successor fully spendable
      // while the replay was still reported as detected. Now the token has to PROVE a living family
      // that names it. A head that is missing, unreadable, dead, or naming a different member is
      // not proof, and an orphan no head vouches for can never be spent again.
      const head = this.requireLiveMember(rec.chainId, token);
      // Between this spend and the caller's rotate() the family has no live member.
      this.writeChain(rec.chainId, { ...head, liveHash: '' });
      return { kind: 'spent', record: rec };
    } finally {
      this.remove(claim);
    }
  }

  private requireLiveMember(chainId: string, token: string): ChainHead {
    const head = this.readChainSafely(chainId);
    if (!head || head.dead || head.liveHash !== this.hash(token)) {
      throw new InvalidTokenError('Refresh token is not the live member of a live chain - re-authorize the Zendesk connector.');
    }
    return head;
  }

  // The chain head carries its own expiresAt (the family's absolute deadline), so the inherited
  // sweep prunes it correctly once it is told the suffix exists.
  protected get expiringSuffixes(): string[] {
    return [...super.expiringSuffixes, SUFFIX_CHAIN, SUFFIX_REPEAT];
  }

  // Claims are swept on staleness, not on the record's expiry: their record carries the chain's
  // deadline, which is far in the future, so the inherited prune would keep them forever. One is
  // left behind by every process that dies mid-spend, and each is an encrypted record of a real
  // grant, so AC5 ("pruned on expiry") has to reach them.
  prune(now: number = Date.now()): void {
    super.prune(now);
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(SUFFIX_CLAIM)) continue;
      const path = join(this.dir, name);
      try {
        if (now - statSync(path).mtimeMs <= CLAIM_STALE_MS) continue;
        // The claim names the token it was renamed from, so the evidence can be reconstructed
        // before the file goes. mtime is a weak liveness signal — a clock skew (NFS, an NTP step)
        // can age a claim that is still in flight — so the sweep is made non-destructive to
        // DETECTION even when it is wrong about liveness: the grant is lost either way, but a later
        // replay still reads as a replay instead of as an unknown token.
        this.tombstoneClaim(path, name);
        this.remove(path);
      } catch {
        /* vanished under us: the outcome we wanted anyway */
      }
    }
  }

  // The claim filename is composed and decomposed in one place, so the sweep reads back exactly the
  // structure the spend wrote rather than re-deriving it with a pattern that can drift apart from it.
  private claimPath(tokenHash: string, nonce: string): string {
    return join(this.dir, `${tokenHash}${CLAIM_INFIX}${nonce}${SUFFIX_CLAIM}`);
  }

  private tokenHashFromClaim(name: string): string | null {
    const cut = name.indexOf(CLAIM_INFIX);
    return cut > 0 && name.endsWith(SUFFIX_CLAIM) ? name.slice(0, cut) : null;
  }

  // Carries a stale claim's own record across into a tombstone before the claim is removed.
  private tombstoneClaim(path: string, name: string): void {
    const tokenHash = this.tokenHashFromClaim(name);
    if (!tokenHash) return;
    const spent = join(this.dir, `${tokenHash}${SUFFIX_SPENT}`);
    if (existsSync(spent)) return;
    const rec = this.readSafely(path);
    if (rec) this.write(spent, { ...rec, spentAt: Date.now() } as Tombstone);
  }

  // Revoke the family a replayed token belongs to. O(1): the head names the one live member.
  // Returns how many live tokens that cost — 0 or 1, because a chain never holds more.
  revokeChain(chainId: string): number {
    const head = this.readChainSafely(chainId);
    // ORDER IS LOAD-BEARING: unlink first, mark dead second. On a full disk the unlink still
    // succeeds while writeChain cannot, so the live member dies even when the head cannot be
    // updated — and since consume() now demands a head that vouches for the token, a head left
    // unwritten refuses the family rather than freeing it.
    const revoked = head?.liveHash ? this.removeExisting(join(this.dir, `${head.liveHash}.enc`)) : 0;
    // A dead head is written even when the old one was unreadable or absent, so the family ends up
    // provably dead rather than merely unverifiable.
    this.writeChain(chainId, { liveHash: '', dead: true, expiresAt: head?.expiresAt ?? Date.now() + this.ttlMs });
    return revoked;
  }

  // The claim failed. Three different things look alike here and used to be answered alike:
  //   - no tombstone            -> this token never existed, or aged out. Refuse.
  //   - tombstone, inside the window, answer stored -> the client is asking again. Repeat it.
  //   - tombstone, inside the window, no answer yet -> somebody else is mid-spend. Refuse WITHOUT
  //     revoking: concurrency is not theft, and revoking here took the winner's session down too.
  //   - tombstone, past the window -> a genuine replay. Revoke, as before.
  private afterClaimFailed(token: string): SpendOutcome {
    const spent = this.readTombstone(token);
    if (!spent) throw new InvalidTokenError('Unknown refresh token - re-authorize the Zendesk connector.');

    const head = this.readChainSafely(spent.chainId);
    if (head?.dead) throw new RefreshTokenReplayError(spent.chainId, 0, true);

    if (Date.now() - spent.spentAt < REPEAT_GRACE_MS) {
      const repeat = this.readRepeat(token);
      // Revocation stays authoritative even inside the window: a family that has been killed, or
      // whose head cannot be read, hands out nothing.
      // `head` must be readable: a stored answer is not a way around an unverifiable family.
      // (`dead` is already refused above, before the window is even considered.)
      if (repeat && head) return { kind: 'repeat', payload: repeat.payload, clientId: repeat.clientId, chainId: spent.chainId };
      throw new RefreshInFlightError();
    }
    throw new RefreshTokenReplayError(spent.chainId, this.revokeChain(spent.chainId), false);
  }

  // Called by the caller once it has produced the response, so a repeat of the same request can be
  // answered with the same bytes. Best-effort: a refresh that succeeded must not fail because its
  // receipt could not be filed.
  rememberRepeat(token: string, payload: string, clientId: string): void {
    try {
      new EncryptedFile(this.pathFor(token, SUFFIX_REPEAT), this.encryptionSecret).save({
        payload,
        clientId,
        expiresAt: Date.now() + REPEAT_GRACE_MS,
      } satisfies RepeatRecord);
    } catch {
      /* no idempotency for this one request; the grant itself stands */
    }
  }

  // protected: the ENOSPC path is only reachable from the outside by making this write fail.
  protected writeTombstone(token: string, rec: Tombstone): void {
    new EncryptedFile(this.pathFor(token, SUFFIX_SPENT), this.encryptionSecret).save(rec);
  }

  private readTombstone(token: string): Tombstone | null {
    try {
      const rec = new EncryptedFile(this.pathFor(token, SUFFIX_SPENT), this.encryptionSecret).load<Partial<Tombstone>>();
      if (!rec || typeof rec.chainId !== 'string' || rec.chainId.length === 0) return null;
      // A tombstone with no spentAt predates the window; treat it as long past, never as fresh.
      return { ...rec, spentAt: Number.isFinite(rec.spentAt) ? (rec.spentAt as number) : 0 } as Tombstone;
    } catch {
      return null; // a corrupt tombstone proves nothing
    }
  }

  private readRepeat(token: string): RepeatRecord | null {
    try {
      const rec = new EncryptedFile(this.pathFor(token, SUFFIX_REPEAT), this.encryptionSecret).load<Partial<RepeatRecord>>();
      if (!rec || typeof rec.payload !== 'string' || typeof rec.clientId !== 'string') return null;
      if (!Number.isFinite(rec.expiresAt) || Date.now() >= (rec.expiresAt as number)) return null;
      return rec as RepeatRecord;
    } catch {
      return null;
    }
  }

  // Reading a token record must never turn a refusal into a crash on any path that has already
  // mutated something.
  private readSafely(path: string): RefreshRecord | null {
    try {
      const rec = this.read(path);
      return rec ? { ...rec, chainId: rec.chainId ?? '' } : null;
    } catch {
      return null;
    }
  }

  // A claimed file that will not decrypt is unrecoverable; the token is already spent by the claim,
  // so refuse it as a token rather than letting a GCM failure escape as something else.
  private readOrRefuse(claim: string): RefreshRecord {
    const rec = this.readSafely(claim);
    if (!rec) throw new InvalidTokenError('Refresh token is unreadable - re-authorize the Zendesk connector.');
    return rec;
  }

  // Best-effort revocation used on the ENOSPC path, where throwing again would hide the real cause.
  private killChain(chainId: string): void {
    try {
      this.revokeChain(chainId);
    } catch {
      /* nothing left to do: the grant already fails closed */
    }
  }

  private chainFile(chainId: string): EncryptedFile {
    // chainId is 16 random bytes rendered as hex, generated here and never client-supplied, so it
    // is a safe path segment by construction.
    return new EncryptedFile(join(this.dir, `${chainId}${SUFFIX_CHAIN}`), this.encryptionSecret);
  }

  // A corrupt head must not turn a refusal into a crash, and a head that decrypts but is not a head
  // (an older schema, a foreign plaintext) is not a head either.
  private readChainSafely(chainId: string): ChainHead | null {
    try {
      const head = this.chainFile(chainId).load<Partial<ChainHead>>();
      if (!head || typeof head.liveHash !== 'string' || typeof head.dead !== 'boolean') return null;
      if (!Number.isFinite(head.expiresAt)) return null;
      return head as ChainHead;
    } catch {
      return null;
    }
  }

  // protected, not private: the head-before-record ordering is an invariant a test has to be able
  // to observe directly, and inferring it from a crash is weaker than watching the two writes.
  protected writeChain(chainId: string, head: ChainHead): void {
    this.chainFile(chainId).save(head);
  }

  private removeExisting(path: string): number {
    if (!existsSync(path)) return 0;
    this.remove(path);
    return 1;
  }
}
