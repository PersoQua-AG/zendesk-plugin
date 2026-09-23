import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { readdirSync, unlinkSync, existsSync } from 'node:fs';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { EncryptedFile } from './encrypted-file.js';

// The shared mechanism behind every opaque token this server hands to claude.ai: a 256-bit random
// bearer, one AES-256-GCM record per token, filename = sha256(token) so the bearer never lands on
// disk raw and no caller-supplied string ever reaches a path. Subclasses add the role —
// IssuedTokenStore the authorize/CSRF state, RefreshTokenStore the single-use spend and rotation.
// Everything this store keeps on disk expires, and prune is the only reader that cares about
// nothing else. Stating that as its own contract stops the sweep from depending on the accident
// that a chain head happens to carry an expiry too.
export interface Expiring {
  expiresAt: number;
}

export interface OpaqueRecord extends Expiring {
  identity: string;
  clientId: string;
  // The rotation family. Only RefreshTokenStore sets it; the access-token role has no chain and
  // leaves it empty, which is why it is optional rather than a fourth mandatory slot.
  chainId?: string;
}

const SUFFIX_LIVE = '.enc';
export const SUFFIX_SPENT = '.spent';

export class OpaqueTokenStore {
  constructor(
    protected readonly dir: string,
    protected readonly encryptionSecret: string,
    protected readonly ttlMs: number,
  ) {}

  // The token lifetime in SECONDS — the unit an OAuth `expires_in` is denominated in. Exposed so a
  // token response reports the lifetime the store actually enforces instead of a second literal.
  get ttlSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  mint(identity: string, clientId = ''): string {
    return this.issue({ identity, clientId, expiresAt: Date.now() + this.ttlMs });
  }

  // Throws InvalidTokenError (the SDK type requireBearerAuth maps to 401) for an unknown or expired
  // token, so claude.ai gets a clean re-auth signal — never a 500. Never returns a partial identity.
  // Messages are surfaced verbatim in the WWW-Authenticate header, which is latin1-only — keep them
  // ASCII (no em dash) or setHeader throws and the clean 401 degrades back into a 500.
  identityFor(token: string): OpaqueRecord {
    const rec = this.read(this.pathFor(token));
    if (!rec) throw new InvalidTokenError('Unknown token - re-authorize the Zendesk connector.');
    if (Date.now() >= rec.expiresAt) throw new InvalidTokenError('Token expired - re-authorize the Zendesk connector.');
    return rec;
  }

  // Unlink records whose decrypted expiresAt is past, so the directory cannot grow without bound
  // (H2). Call at startup and on the daily timer. A torn/corrupt file is unlinked too, never
  // aborting the sweep: it is unrecoverable, and leaving it would let a flood fill the disk.
  prune(now: number = Date.now()): void {
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      if (!this.expiringSuffixes.some((s) => name.endsWith(s))) continue;
      const path = join(this.dir, name);
      try {
        const rec = this.readExpiring(path);
        if (!rec || now >= rec.expiresAt) this.remove(path);
      } catch {
        this.remove(path);
      }
    }
  }

  // Files pruned by their own recorded expiry. `.claim` is deliberately absent: it is swept on a
  // staleness rule by whoever creates it. A subclass with more record kinds widens this.
  protected get expiringSuffixes(): string[] {
    return [SUFFIX_LIVE, SUFFIX_SPENT];
  }

  protected issue(rec: OpaqueRecord): string {
    const opaque = randomBytes(32).toString('hex');
    this.write(this.pathFor(opaque), rec);
    return opaque;
  }

  // Filename is sha256(token): a token containing `../`, a NUL byte or an absolute path hashes to
  // the same 64 hex characters as any other, so path traversal is structurally impossible.
  protected pathFor(opaque: string, suffix: string = SUFFIX_LIVE): string {
    return join(this.dir, `${this.hash(opaque)}${suffix}`);
  }

  protected hash(opaque: string): string {
    return createHash('sha256').update(opaque).digest('hex');
  }

  protected write(path: string, rec: OpaqueRecord): void {
    new EncryptedFile(path, this.encryptionSecret).save(rec);
  }

  // Returns null for a missing file; a decrypt/integrity failure propagates so callers can decide
  // (prune unlinks it, the token paths refuse the token) rather than silently treating it as absent.
  protected read(path: string): OpaqueRecord | null {
    const rec = new EncryptedFile(path, this.encryptionSecret).load<Partial<OpaqueRecord>>();
    // load<T>() is an unchecked cast over whatever JSON the file held, so the shape is checked here
    // rather than trusted. An older release wrote {accessToken, refreshToken, expiresAt}; without
    // this that record is ACCEPTED with identity undefined, and a record with no expiresAt is
    // immortal, because `now >= undefined` is false. A record that is not one is not a record.
    if (!rec || typeof rec.identity !== 'string' || rec.identity.length === 0) return null;
    if (!Number.isFinite(rec.expiresAt)) return null;
    return rec as OpaqueRecord;
  }

  // The sweep's reader: it needs an expiry and nothing else, so it accepts every record kind this
  // directory holds — token records and chain heads alike.
  protected readExpiring(path: string): Expiring | null {
    const rec = new EncryptedFile(path, this.encryptionSecret).load<Partial<Expiring>>();
    if (!rec || !Number.isFinite(rec.expiresAt)) return null;
    return rec as Expiring;
  }

  // Best-effort unlink: a concurrent sweep or consume may have removed the file already, and that
  // is the same outcome we wanted. Callers that need the removal to MEAN something (the single-use
  // claim in RefreshTokenStore) must not use this.
  protected remove(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}
