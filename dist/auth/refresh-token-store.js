import { randomBytes } from 'node:crypto';
import { renameSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { EncryptedFile } from './encrypted-file.js';
import { OpaqueTokenStore, SUFFIX_SPENT } from './opaque-token-store.js';
// A presented refresh token that was ALREADY rotated. RFC 6819 §5.2.2.3: with rotation in place, a
// replay is the classic indicator of a stolen chain, so the whole family is revoked. `revoked` is
// how many live tokens that actually cost — a chain holds at most one, so it is 0 or 1, and the
// caller logs the number instead of asserting "revoked" with nothing behind it.
export class RefreshTokenReplayError extends InvalidTokenError {
    chainId;
    revoked;
    alreadyDead;
    constructor(chainId, revoked, alreadyDead) {
        super('Refresh token was already used - re-authorize the Zendesk connector.');
        this.chainId = chainId;
        this.revoked = revoked;
        this.alreadyDead = alreadyDead;
    }
}
const SUFFIX_CHAIN = '.chain';
// A claim exists only for the microseconds between winning the rename and finishing the spend.
// Anything older is the residue of a process that died mid-spend, and is safe to sweep: a live
// spend can never be this old, so sweeping cannot disturb the rename's race-freeness.
const CLAIM_STALE_MS = 60_000;
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
    mint(identity, clientId = '') {
        const chainId = randomBytes(16).toString('hex');
        const expiresAt = Date.now() + this.ttlMs;
        return this.link({ identity, clientId, chainId, expiresAt }, chainId, expiresAt);
    }
    // Rotation: same family, same deadline, new token. A dead or unverifiable family does not rotate
    // — the successor would be a token no head vouches for, which is exactly what consume() refuses.
    rotate(previous, clientId) {
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
    link(rec, chainId, expiresAt) {
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
    consume(token) {
        const live = this.pathFor(token);
        // Expiry is judged BEFORE anything is destroyed. A clock that jumps past the family deadline
        // and is then corrected would otherwise burn an honest user's token and, on their retry,
        // revoke their chain for a replay they never committed.
        const preview = this.readSafely(live);
        if (preview && Date.now() >= preview.expiresAt) {
            throw new InvalidTokenError('Refresh token expired - re-authorize the Zendesk connector.');
        }
        const claim = `${live}.${randomBytes(8).toString('hex')}.claim`;
        try {
            renameSync(live, claim);
        }
        catch {
            throw this.refuseUnclaimed(token);
        }
        try {
            const rec = this.readOrRefuse(claim);
            try {
                // Tombstone BEFORE anything else can refuse: if the caller crashes after this, the token is
                // still spent, and a later replay is still recognisable as a replay rather than as unknown.
                this.write(this.pathFor(token, SUFFIX_SPENT), rec);
            }
            catch (err) {
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
            return rec;
        }
        finally {
            this.remove(claim);
        }
    }
    requireLiveMember(chainId, token) {
        const head = this.readChainSafely(chainId);
        if (!head || head.dead || head.liveHash !== this.hash(token)) {
            throw new InvalidTokenError('Refresh token is not the live member of a live chain - re-authorize the Zendesk connector.');
        }
        return head;
    }
    // The chain head carries its own expiresAt (the family's absolute deadline), so the inherited
    // sweep prunes it correctly once it is told the suffix exists.
    get expiringSuffixes() {
        return [...super.expiringSuffixes, SUFFIX_CHAIN];
    }
    // Claims are swept on staleness, not on the record's expiry: their record carries the chain's
    // deadline, which is far in the future, so the inherited prune would keep them forever. One is
    // left behind by every process that dies mid-spend, and each is an encrypted record of a real
    // grant, so AC5 ("pruned on expiry") has to reach them.
    prune(now = Date.now()) {
        super.prune(now);
        if (!existsSync(this.dir))
            return;
        for (const name of readdirSync(this.dir)) {
            if (!name.endsWith('.claim'))
                continue;
            const path = join(this.dir, name);
            try {
                if (now - statSync(path).mtimeMs <= CLAIM_STALE_MS)
                    continue;
                // The claim names the token it was renamed from, so the evidence can be reconstructed
                // before the file goes. mtime is a weak liveness signal — a clock skew (NFS, an NTP step)
                // can age a claim that is still in flight — so the sweep is made non-destructive to
                // DETECTION even when it is wrong about liveness: the grant is lost either way, but a later
                // replay still reads as a replay instead of as an unknown token.
                this.tombstoneClaim(path, name);
                this.remove(path);
            }
            catch {
                /* vanished under us: the outcome we wanted anyway */
            }
        }
    }
    // `<sha256>.enc.<hex>.claim` -> `<sha256>.spent`, carrying the claim's own record across.
    tombstoneClaim(path, name) {
        const spent = name.replace(/\.enc\.[0-9a-f]+\.claim$/, SUFFIX_SPENT);
        if (spent === name || existsSync(join(this.dir, spent)))
            return;
        const rec = this.readSafely(path);
        if (rec)
            this.write(join(this.dir, spent), rec);
    }
    // Revoke the family a replayed token belongs to. O(1): the head names the one live member.
    // Returns how many live tokens that cost — 0 or 1, because a chain never holds more.
    revokeChain(chainId) {
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
    // The claim failed. Either the token never existed / already aged out of the store, or it was
    // rotated earlier and left a tombstone — and only the second case is evidence of theft.
    refuseUnclaimed(token) {
        let spent = null;
        try {
            spent = this.read(this.pathFor(token, SUFFIX_SPENT));
        }
        catch {
            spent = null; // a corrupt tombstone proves nothing; fall through to the plain refusal
        }
        if (!spent?.chainId)
            return new InvalidTokenError('Unknown refresh token - re-authorize the Zendesk connector.');
        // Already-dead chain: answer in O(1) without touching anything. This is the case a flood
        // repeats, so it must stay the cheapest one — the earlier design re-swept the whole directory
        // here, every single time, for a burnt token that cost the attacker nothing to resend.
        const head = this.readChainSafely(spent.chainId);
        if (head?.dead)
            return new RefreshTokenReplayError(spent.chainId, 0, true);
        return new RefreshTokenReplayError(spent.chainId, this.revokeChain(spent.chainId), false);
    }
    // Reading a token record must never turn a refusal into a crash on any path that has already
    // mutated something.
    readSafely(path) {
        try {
            const rec = this.read(path);
            return rec ? { ...rec, chainId: rec.chainId ?? '' } : null;
        }
        catch {
            return null;
        }
    }
    // A claimed file that will not decrypt is unrecoverable; the token is already spent by the claim,
    // so refuse it as a token rather than letting a GCM failure escape as something else.
    readOrRefuse(claim) {
        const rec = this.readSafely(claim);
        if (!rec)
            throw new InvalidTokenError('Refresh token is unreadable - re-authorize the Zendesk connector.');
        return rec;
    }
    // Best-effort revocation used on the ENOSPC path, where throwing again would hide the real cause.
    killChain(chainId) {
        try {
            this.revokeChain(chainId);
        }
        catch {
            /* nothing left to do: the grant already fails closed */
        }
    }
    chainFile(chainId) {
        // chainId is 16 random bytes rendered as hex, generated here and never client-supplied, so it
        // is a safe path segment by construction.
        return new EncryptedFile(join(this.dir, `${chainId}${SUFFIX_CHAIN}`), this.encryptionSecret);
    }
    readChain(chainId) {
        const head = this.chainFile(chainId).load();
        // A head that decrypts but is not a head (an older schema, a foreign plaintext) is not a head.
        if (!head || typeof head.liveHash !== 'string' || typeof head.dead !== 'boolean')
            return null;
        if (!Number.isFinite(head.expiresAt))
            return null;
        return head;
    }
    // A corrupt head must not turn a refusal into a crash; it is pruned like any other torn file.
    readChainSafely(chainId) {
        try {
            return this.readChain(chainId);
        }
        catch {
            return null;
        }
    }
    // protected, not private: the head-before-record ordering is an invariant a test has to be able
    // to observe directly, and inferring it from a crash is weaker than watching the two writes.
    writeChain(chainId, head) {
        this.chainFile(chainId).save(head);
    }
    removeExisting(path) {
        if (!existsSync(path))
            return 0;
        this.remove(path);
        return 1;
    }
}
