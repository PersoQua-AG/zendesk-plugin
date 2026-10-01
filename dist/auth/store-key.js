// src/auth/store-key.ts
// Everything this plugin keeps in the macOS Keychain: the token-store key, and — since the first-run
// setup page — the three OAuth values the customer enters there (subdomain, client id, client
// secret). One file, because there is one way in: the `security` built-in, reached with an ARGUMENT
// ARRAY and never a shell string, so no value here can be word-split or interpreted by a shell. Both
// the guard in tests/plugin/no-process-spawn.test.ts and the single sanctioned child process depend
// on that staying true of exactly this file.
//
// The key the token store is encrypted with. It is a RANDOM 32-byte value kept in the macOS
// Keychain, deliberately not the OAuth client secret: rotating the client secret must not brick the
// stored tokens, and the client secret must not double as the decrypt-all key. Same reasoning, same
// shape and the same entropy floor as the remote path's REMOTE_TOKEN_ENC_KEY
// (src/remote/remote-server.ts:78-88), which is where this pattern already runs in production.
//
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const SECURITY_BIN = '/usr/bin/security';
const SERVICE = 'zendesk-plugin';
const ACCOUNT = 'token-store-key';
// The three OAuth values, by the env var each one stands in for — so the merge in ./config.ts is a
// plain object spread and neither side needs to know the other's spelling. The client id and the
// subdomain are in here beside the secret by owner decision: the id is internal, and the instance
// name is not to lie around in the open either.
export const CONFIG_ACCOUNTS = {
    ZENDESK_SUBDOMAIN: 'oauth-subdomain',
    ZENDESK_OAUTH_CLIENT_ID: 'oauth-client-id',
    ZENDESK_OAUTH_CLIENT_SECRET: 'oauth-client-secret',
};
// macOS only, and the one place that is decided. Windows and Linux are #69; nothing falls back to
// anything weaker, here or anywhere else.
export function keychainAvailable(platform = process.platform) {
    return platform === 'darwin';
}
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
// A non-zero exit that is NOT "item not found": locked, access denied, user cancelled. Never carries
// `output`, because on a read path stdout is the value itself.
function unreadable(status) {
    return new Error(`The macOS Keychain could not be read (security exited ${status}). Unlock the login keychain, ` +
        'allow access when asked, then try again.');
}
export const UNSUPPORTED_PLATFORM = 'The Zendesk token store needs a key from the macOS Keychain, and this is not macOS. A Windows or ' +
    'Linux key source is issue #69 (github.com/PersoQua-AG/zendesk-plugin/issues/69); there is ' +
    'deliberately no weaker fallback.';
// Reads the key, creating it on first use. Platform and runner are parameters so the resolution is
// testable without a real Keychain and without mutating the process.
export function resolveTokenStoreKey(platform = process.platform, run = runSecurity) {
    if (!keychainAvailable(platform))
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
    if (found.status !== ITEM_NOT_FOUND)
        throw unreadable(found.status);
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
const configEntries = Object.entries(CONFIG_ACCOUNTS);
// What the setup page stored, if anything. A missing item is simply absent — that is the first run,
// not a failure — while a Keychain that cannot be READ throws, because answering "nothing is stored"
// for a locked keychain would send a configured user back through setup and overwrite what is there.
//
// Returns {} off macOS rather than throwing: an env-configured install (Claude Code as it works
// today) must not be made to depend on a key source that platform does not have.
export function readKeychainConfig(platform = process.platform, run = runSecurity) {
    if (!keychainAvailable(platform))
        return {};
    const stored = {};
    for (const [name, account] of configEntries) {
        const found = run(['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
        if (found.status === ITEM_NOT_FOUND)
            continue;
        if (found.status !== 0)
            throw unreadable(found.status);
        // `security -w` ends its output with a newline; an item that holds only whitespace is as absent
        // as a missing one, and must not pass the required() check downstream as a value.
        const value = found.output.trim();
        if (value)
            stored[name] = value;
    }
    return stored;
}
// All three or nothing: a half-written set would leave the plugin configured with a subdomain and no
// client, which is a state the setup page cannot tell apart from a fresh machine. -U so a retry
// replaces what an earlier attempt left behind instead of failing on a collision.
export function writeKeychainConfig(values, platform = process.platform, run = runSecurity) {
    if (!keychainAvailable(platform))
        throw new Error(UNSUPPORTED_PLATFORM);
    for (const [name, account] of configEntries) {
        const added = run(['add-generic-password', '-s', SERVICE, '-a', account, '-w', values[name], '-U']);
        if (added.status !== 0) {
            // The account name, never the value.
            throw new Error(`"${account}" could not be written to the macOS Keychain (security exited ${added.status}).`);
        }
    }
}
