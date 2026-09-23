import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { readdirSync, unlinkSync, existsSync } from 'node:fs';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { TokenStore } from './token-store.js';
// Files this store owns. `.enc` is a live token; `.spent` is the tombstone RefreshTokenStore leaves
// behind so a replayed token is DETECTED rather than merely unknown. Both are pruned on expiry.
const SUFFIXES = ['.enc', '.spent'];
export class OpaqueTokenStore {
    dir;
    encryptionSecret;
    ttlMs;
    constructor(dir, encryptionSecret, ttlMs) {
        this.dir = dir;
        this.encryptionSecret = encryptionSecret;
        this.ttlMs = ttlMs;
    }
    // The token lifetime in SECONDS — the unit an OAuth `expires_in` is denominated in. Exposed so a
    // token response reports the lifetime the store actually enforces instead of a second literal.
    get ttlSeconds() {
        return Math.floor(this.ttlMs / 1000);
    }
    // chainId defaults to a fresh rotation family: a token minted outside a rotation (a new login)
    // starts its own chain, so revoking one stolen chain never touches another session.
    mint(identity, clientId = '', chainId = randomBytes(16).toString('hex')) {
        const opaque = randomBytes(32).toString('hex');
        this.write(this.pathFor(opaque), { identity, clientId, chainId, expiresAt: Date.now() + this.ttlMs });
        return opaque;
    }
    // Throws InvalidTokenError (the SDK type requireBearerAuth maps to 401) for an unknown or expired
    // token, so claude.ai gets a clean re-auth signal — never a 500. Never returns a partial identity.
    // Messages are surfaced verbatim in the WWW-Authenticate header, which is latin1-only — keep them
    // ASCII (no em dash) or setHeader throws and the clean 401 degrades back into a 500.
    identityFor(token) {
        const rec = this.read(this.pathFor(token));
        if (!rec)
            throw new InvalidTokenError('Unknown access token - re-authorize the Zendesk connector.');
        if (Date.now() >= rec.expiresAt)
            throw new InvalidTokenError('Access token expired - re-authorize the Zendesk connector.');
        return rec;
    }
    // Unlink files whose decrypted expiresAt is past, so the directory cannot grow without bound (H2).
    // Call at startup and on the daily timer. A torn/corrupt file is unlinked too, never aborting the
    // sweep: it is unrecoverable, and leaving it would let a flood fill the disk.
    prune(now = Date.now()) {
        if (!existsSync(this.dir))
            return;
        for (const name of readdirSync(this.dir)) {
            if (!SUFFIXES.some((s) => name.endsWith(s)))
                continue;
            const path = join(this.dir, name);
            try {
                const rec = this.read(path);
                if (!rec || now >= rec.expiresAt)
                    this.remove(path);
            }
            catch {
                this.remove(path);
            }
        }
    }
    // Filename is sha256(token): a token containing `../`, a NUL byte or an absolute path hashes to
    // the same 64 hex characters as any other, so path traversal is structurally impossible.
    pathFor(opaque, suffix = '.enc') {
        return join(this.dir, `${createHash('sha256').update(opaque).digest('hex')}${suffix}`);
    }
    write(path, rec) {
        const stored = { accessToken: rec.identity, refreshToken: rec.clientId, expiresAt: rec.expiresAt, chainId: rec.chainId };
        new TokenStore(path, this.encryptionSecret).save(stored);
    }
    // Returns null for a missing file; a decrypt/integrity failure propagates so callers can decide
    // (prune unlinks it, the token paths refuse the token) rather than silently treating it as absent.
    read(path) {
        const rec = new TokenStore(path, this.encryptionSecret).load();
        if (!rec)
            return null;
        return { identity: rec.accessToken, clientId: rec.refreshToken, chainId: rec.chainId ?? '', expiresAt: rec.expiresAt };
    }
    // Best-effort unlink: a concurrent sweep or consume may have removed the file already, and that
    // is the same outcome we wanted. Callers that need the removal to MEAN something (the single-use
    // claim in RefreshTokenStore) must not use this.
    remove(path) {
        try {
            unlinkSync(path);
        }
        catch {
            /* already gone */
        }
    }
}
