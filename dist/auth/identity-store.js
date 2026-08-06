import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TokenStore } from './token-store.js';
// One AES-256-GCM file per connector identity under <dataDir>/users/. The identity is hashed
// (not stored raw) so the filesystem never carries a user identifier in cleartext. Each file
// reuses TokenStore verbatim — same cipher, same fail-closed load — so per-user isolation adds
// only the "which file" axis, no new crypto.
export class IdentityTokenStore {
    usersDir;
    encryptionSecret;
    constructor(usersDir, encryptionSecret) {
        this.usersDir = usersDir;
        this.encryptionSecret = encryptionSecret;
    }
    storeFor(identity) {
        return new TokenStore(join(this.usersDir, `${this.fileKey(identity)}.enc`), this.encryptionSecret);
    }
    fileKey(identity) {
        return createHash('sha256').update(`zendesk-user:${identity}`).digest('hex');
    }
}
