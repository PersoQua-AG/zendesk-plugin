import { randomBytes } from 'node:crypto';
import { renameSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { EncryptedFile } from './encrypted-file.js';
import { OpaqueTokenStore } from './opaque-token-store.js';
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
const SUFFIX_SPENT = '.spent';
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
        const token = this.issue({ identity, clientId, chainId, expiresAt });
        this.writeChain(chainId, { liveHash: this.hash(token), dead: false, expiresAt });
        return token;
    }
    // Rotation: same family, same deadline, new token. Only the head moves.
    rotate(previous, clientId) {
        const token = this.issue({ ...previous, clientId, chainId: previous.chainId });
        const head = this.readChain(previous.chainId);
        this.writeChain(previous.chainId, {
            liveHash: this.hash(token),
            dead: head?.dead ?? false,
            expiresAt: previous.expiresAt,
        });
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
        const claim = `${this.pathFor(token)}.${randomBytes(8).toString('hex')}.claim`;
        try {
            renameSync(this.pathFor(token), claim);
        }
        catch {
            throw this.refuseUnclaimed(token);
        }
        try {
            const rec = this.readOrRefuse(claim);
            try {
                // Tombstone BEFORE returning: if the caller crashes after this, the token is still spent,
                // and a later replay is still recognisable as a replay rather than as an unknown token.
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
            // The chain has no live member between the spend and the caller's rotate().
            const head = this.readChain(rec.chainId);
            if (head)
                this.writeChain(rec.chainId, { ...head, liveHash: '' });
            if (Date.now() >= rec.expiresAt) {
                throw new InvalidTokenError('Refresh token expired - re-authorize the Zendesk connector.');
            }
            return rec;
        }
        finally {
            this.remove(claim);
        }
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
                if (now - statSync(path).mtimeMs > CLAIM_STALE_MS)
                    this.remove(path);
            }
            catch {
                /* vanished under us: the outcome we wanted anyway */
            }
        }
    }
    // Revoke the family a replayed token belongs to. O(1): the head names the one live member.
    // Returns how many live tokens that cost — 0 or 1, because a chain never holds more.
    revokeChain(chainId) {
        const head = this.readChainSafely(chainId);
        if (!head)
            return 0;
        const revoked = head.liveHash ? this.removeExisting(join(this.dir, `${head.liveHash}.enc`)) : 0;
        this.writeChain(chainId, { ...head, liveHash: '', dead: true });
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
    // A claimed file that will not decrypt is unrecoverable; the token is already spent by the claim,
    // so refuse it as a token rather than letting a GCM failure escape as something else.
    readOrRefuse(claim) {
        let rec;
        try {
            rec = this.read(claim);
        }
        catch {
            rec = null;
        }
        if (!rec)
            throw new InvalidTokenError('Refresh token is unreadable - re-authorize the Zendesk connector.');
        return { ...rec, chainId: rec.chainId ?? '' };
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
        return this.chainFile(chainId).load();
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
