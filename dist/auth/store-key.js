// src/auth/store-key.ts
// Everything this plugin keeps in the macOS Keychain: the token-store key, and the three OAuth values
// the first-run setup page collects (subdomain, client id, client secret). One file, because there is
// one way in — the `security` built-in, reached with an ARGUMENT ARRAY and never a shell string — and
// both tests/plugin/no-process-spawn.test.ts and the single sanctioned child process depend on that
// staying true of exactly this file.
//
// The token-store key is a RANDOM 32-byte value and deliberately not the OAuth client secret: rotating
// the secret must not brick the stored tokens, and the secret must not double as the decrypt-all key.
// Same reasoning, same shape and the same entropy floor as the remote path's REMOTE_TOKEN_ENC_KEY
// (src/remote/remote-server.ts:78-88), which is where this pattern already runs in production.
//
// EVERY SECRET GOES IN THROUGH STDIN. `man security`: "-w password — Specify password to be added. Put
// at end of command to be prompted (recommended)". An argv element is readable by `ps` for the lifetime
// of the call, and the values here are the customer's client secret and the key to their tokens.
// Measured: with `-w` last, `security` prompts twice (password, retype), so the value is written twice.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const SECURITY_BIN = '/usr/bin/security';
const SERVICE = 'zendesk-plugin';
const ACCOUNT = 'token-store-key';
// `security` exits 44 for "item not found" — the ordinary first-run case. Any other non-zero exit is a
// locked, denied or unreadable Keychain, and that must NOT be mistaken for "nothing stored yet":
// creating a second key there would silently make every stored token undecryptable, and overwriting a
// stored configuration would discard a working one.
export const KEYCHAIN_ABSENT = 44;
// There is no `security` binary at all, i.e. this is not macOS. That is not a failure of the Keychain,
// it is the absence of one (#69), and the two are answered differently everywhere below.
export const KEYCHAIN_UNAVAILABLE = -1;
const SPAWN_FAILED = -2;
// 32 bytes = a 256-bit AES key's worth. Lifted verbatim from src/remote/remote-server.ts:27-36.
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
// A runner with no Keychain to reach: what the remote bridge passes, so a macOS-hosted bridge can never
// serve remote users out of the operator's own personal OAuth client.
export const noKeychain = () => ({ status: KEYCHAIN_UNAVAILABLE, output: '' });
// `bin` is a parameter so that both outcomes of this function — and the three ways it can fail — are
// MEASURED rather than excluded from coverage: a test runs it against /bin/echo, a binary that exits
// non-zero, a path that does not exist, and a process that dies on a signal, on any platform.
export function runSecurity(args, input, bin = SECURITY_BIN) {
    try {
        // stdin is always a pipe, so a command that prompts reads what it was given and one that does not
        // sees EOF. stderr is discarded: `security` writes its prompts and diagnostics there, and stderr on
        // the stdio path belongs to util/warn-config.ts alone.
        const output = execFileSync(bin, args, {
            input: input ?? '',
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        return { status: 0, output };
    }
    catch (err) {
        const { code, status } = err;
        if (code === 'ENOENT')
            return { status: KEYCHAIN_UNAVAILABLE, output: '' };
        return { status: typeof status === 'number' ? status : SPAWN_FAILED, output: '' };
    }
}
export const UNSUPPORTED_PLATFORM = 'The Zendesk configuration and the token-store key live in the macOS Keychain, and this is not macOS. ' +
    'A Windows or Linux key source is issue #69 (github.com/PersoQua-AG/zendesk-plugin/issues/69); until ' +
    'then pass ZENDESK_SUBDOMAIN, ZENDESK_OAUTH_CLIENT_ID and ZENDESK_OAUTH_CLIENT_SECRET in the ' +
    'environment. There is deliberately no weaker fallback.';
// Never carries `output`, because on a read path stdout is the value itself.
function unreadable(status) {
    return new Error(`The macOS Keychain could not be read (security exited ${status}). Unlock the login keychain, ` +
        'allow access when asked, then try again.');
}
// `-w` LAST and the value on stdin, twice: see the file header.
function writeItem(run, account, value) {
    return run(['add-generic-password', '-s', SERVICE, '-a', account, '-U', '-w'], `${value}\n${value}\n`);
}
// Reads the key, creating it on first use.
export function resolveTokenStoreKey(run = runSecurity) {
    const found = run(['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
    if (found.status === 0) {
        const key = found.output.trim();
        if (encKeyStrengthBytes(key) < MIN_ENC_KEY_BYTES) {
            throw new Error(`The Keychain item "${SERVICE}/${ACCOUNT}" carries fewer than ${MIN_ENC_KEY_BYTES} bytes of ` +
                'entropy. Delete it in Keychain Access and run the login again to have a fresh key created.');
        }
        return key;
    }
    if (found.status === KEYCHAIN_UNAVAILABLE)
        throw new Error(UNSUPPORTED_PLATFORM);
    if (found.status !== KEYCHAIN_ABSENT)
        throw unreadable(found.status);
    const key = randomBytes(MIN_ENC_KEY_BYTES).toString('base64');
    const added = writeItem(run, ACCOUNT, key);
    if (added.status !== 0) {
        throw new Error(`The token-store key could not be written to the macOS Keychain (security exited ${added.status}).`);
    }
    return key;
}
// The three OAuth values, by the env var each one stands in for — so the merge in ./config.ts is a plain
// object spread and neither side needs to know the other's spelling. The client id and the subdomain are
// in here beside the secret by owner decision: the id is internal, and the instance name is not to lie
// around in the open either.
export const CONFIG_ACCOUNTS = {
    ZENDESK_SUBDOMAIN: 'oauth-subdomain',
    ZENDESK_OAUTH_CLIENT_ID: 'oauth-client-id',
    ZENDESK_OAUTH_CLIENT_SECRET: 'oauth-client-secret',
};
const configEntries = Object.entries(CONFIG_ACCOUNTS);
// What the setup page stored, if anything. A missing item is simply absent — that is the first run, not a
// failure — while a Keychain that cannot be READ throws, because answering "nothing is stored" for a
// locked or denied one would send a configured user back through setup and overwrite what is there. No
// Keychain at all (another platform) is {}: an env-configured install must not be made to depend on a
// source that platform does not have.
export function readKeychainConfig(run = runSecurity) {
    const stored = {};
    for (const [name, account] of configEntries) {
        const found = run(['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
        if (found.status === KEYCHAIN_UNAVAILABLE)
            return {};
        if (found.status === KEYCHAIN_ABSENT)
            continue;
        if (found.status !== 0)
            throw unreadable(found.status);
        // `security -w` ends its output with a newline; an item holding only whitespace is as absent as a
        // missing one and must not pass the required() check downstream as a value.
        //
        // What it does NOT do is return the value verbatim in every case: measured on macOS, a password that
        // is not plain ASCII comes back as HEX. Nothing is decoded here on purpose — the place to refuse such
        // a value is where a person types it (../tools/setup.ts, PRINTABLE_ASCII), because a value stored
        // today and read back mangled tomorrow authorizes nothing and points at nothing.
        const value = found.output.trim();
        if (value)
            stored[name] = value;
    }
    return stored;
}
// ALL THREE OR NOTHING, and this time it is what the code does. A set of TWO is a configuration that
// resolves — the client secret is optional on the code path — so the next start would find it complete,
// never degrade, never offer the setup page again, and the user would be locked out for good. A failure
// therefore takes back what it has already written.
export function writeKeychainConfig(values, run = runSecurity) {
    const written = [];
    for (const [name, account] of configEntries) {
        const added = writeItem(run, account, values[name]);
        if (added.status === 0) {
            written.push(account);
            continue;
        }
        const platform = added.status === KEYCHAIN_UNAVAILABLE ? ` ${UNSUPPORTED_PLATFORM}` : '';
        // The account name, never the value.
        throw new Error(`"${account}" could not be written to the macOS Keychain (security exited ${added.status}).` +
            `${rollback(run, written)}${platform}`);
    }
    // Read back before returning, because exit 0 is not proof: `security` stores an EMPTY password and
    // exits 0 when its retype prompt sees EOF — which is exactly what the value-on-stdin form risks, and it
    // would leave a configuration that resolves, authorizes nothing, and points at no symptom.
    const stored = readKeychainConfig(run);
    const wrong = configEntries.filter(([name]) => stored[name] !== values[name]).map(([, account]) => account);
    if (wrong.length > 0) {
        throw new Error(`the macOS Keychain did not keep ${wrong.map((account) => `"${account}"`).join(', ')} as written.` +
            rollback(run, written));
    }
}
// Returns what to append to the failure: whether the half-written set is really gone. A delete that
// itself fails is the one case the user has to act on by hand, so it is named rather than swallowed.
function rollback(run, written) {
    const left = written.filter((account) => run(['delete-generic-password', '-s', SERVICE, '-a', account]).status !== 0);
    if (left.length === 0)
        return ' Nothing was left behind.';
    return (` ${left.map((account) => `"${account}"`).join(', ')} could not be removed again — delete ` +
        `${left.length === 1 ? 'it' : 'them'} under the service "${SERVICE}" in Keychain Access before trying again.`);
}
