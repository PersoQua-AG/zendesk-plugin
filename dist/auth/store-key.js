// src/auth/store-key.ts
// The key the token store is encrypted with. It is a RANDOM 32-byte value kept in the macOS
// Keychain, deliberately not the OAuth client secret: rotating the client secret must not brick the
// stored tokens, and the client secret must not double as the decrypt-all key. Same reasoning, same
// shape and the same entropy floor as the remote path's REMOTE_TOKEN_ENC_KEY
// (src/remote/remote-server.ts:78-88), which is where this pattern already runs in production.
//
// The Keychain is reached through the macOS `security` built-in with an ARGUMENT ARRAY — never a
// shell string, so no value here can be word-split or interpreted by a shell.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const SECURITY_BIN = '/usr/bin/security';
const SERVICE = 'zendesk-plugin';
const ACCOUNT = 'token-store-key';
// `security` exits 44 for "item not found" — the ordinary first-run case. Any other non-zero exit is
// a locked or unreadable Keychain, and that must NOT be mistaken for "no key yet": creating a second
// key there would silently make every stored token undecryptable.
const ITEM_NOT_FOUND = 44;
// 32 bytes = a 256-bit AES key's worth. Lifted verbatim from src/remote/remote-server.ts:27-36
// rather than invented here.
const MIN_ENC_KEY_BYTES = 32;
// ponytail: the second copy of remote-server.ts's strength gate, because #68 may not touch
// src/remote/**. Upgrade path — when a third caller appears, both import it from here.
export function encKeyStrengthBytes(key) {
    if (/^[0-9a-fA-F]+$/.test(key) && key.length % 2 === 0)
        return key.length / 2;
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(key))
        return Buffer.from(key, 'base64').length;
    return Buffer.byteLength(key, 'utf8');
}
// stdio: stderr is discarded rather than inherited — `security` writes its own diagnostics there and
// stderr on the stdio path belongs to util/warn-config.ts alone. A missing binary (every non-macOS
// platform) has no exit status at all, which is -1 here: not 44, so it is never read as "no key yet".
//
// `bin` is a parameter so the two outcomes of this function can be MEASURED rather than excluded from
// coverage: a test runs it against /bin/echo and against a path that does not exist, on any platform.
export function runSecurity(args, bin = SECURITY_BIN) {
    try {
        return { status: 0, output: execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
    }
    catch (err) {
        const status = err.status;
        return { status: typeof status === 'number' ? status : -1, output: '' };
    }
}
export const UNSUPPORTED_PLATFORM = 'The Zendesk token store needs a key from the macOS Keychain, and this is not macOS. A Windows or ' +
    'Linux key source is issue #69 (github.com/PersoQua-AG/zendesk-plugin/issues/69); there is ' +
    'deliberately no weaker fallback.';
// Reads the key, creating it on first use. Platform and runner are parameters so the resolution is
// testable without a real Keychain and without mutating the process.
export function resolveTokenStoreKey(platform = process.platform, run = (args) => runSecurity(args)) {
    if (platform !== 'darwin')
        throw new Error(UNSUPPORTED_PLATFORM);
    const found = run(['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
    if (found.status === 0) {
        const key = found.output.trim();
        if (encKeyStrengthBytes(key) < MIN_ENC_KEY_BYTES) {
            throw new Error(`The Keychain item "${SERVICE}/${ACCOUNT}" carries fewer than ${MIN_ENC_KEY_BYTES} bytes of ` +
                'entropy. Delete it in Keychain Access and run the login again to have a fresh key created.');
        }
        return key;
    }
    if (found.status !== ITEM_NOT_FOUND) {
        throw new Error(`The macOS Keychain could not be read for the token-store key (security exited ${found.status}). ` +
            'Unlock the login keychain, then reload the extension.');
    }
    const key = randomBytes(MIN_ENC_KEY_BYTES).toString('base64');
    // ponytail: the new key travels as an argv element, so it is visible to `ps` for the lifetime of
    // this one call. `security add-generic-password` offers no stdin form. Upgrade path — a short
    // Security-framework helper, or `-X` with a temp file, if that window ever has to close.
    const added = run(['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', key, '-U']);
    if (added.status !== 0) {
        throw new Error(`The token-store key could not be written to the macOS Keychain (security exited ${added.status}).`);
    }
    return key;
}
