import { describe, it, expect } from 'vitest';
import {
  CONFIG_ACCOUNTS,
  KEYCHAIN_ABSENT,
  KEYCHAIN_UNAVAILABLE,
  encKeyStrengthBytes,
  noKeychain,
  readKeychainConfig,
  resolveTokenStoreKey,
  runSecurity,
  UNSUPPORTED_PLATFORM,
  writeKeychainConfig,
} from '../../src/auth/store-key.js';
import { fakeKeychain, TEST_STORE_KEY, TOKEN_STORE_ACCOUNT } from './keychain.js';

const CONFIG = {
  ZENDESK_SUBDOMAIN: 'acme',
  ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
  ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
};
const ACCOUNTS = Object.values(CONFIG_ACCOUNTS);

describe('the token-store key', () => {
  it('is read from the login keychain by service and account, as an argument ARRAY', () => {
    const fake = fakeKeychain({ items: { [TOKEN_STORE_ACCOUNT]: TEST_STORE_KEY } });
    expect(resolveTokenStoreKey(fake.run)).toBe(TEST_STORE_KEY);
    // Not a shell string: every value is its own argv element, so nothing can be word-split, globbed
    // or interpreted by a shell.
    expect(fake.calls.map((call) => call.args)).toEqual([
      ['find-generic-password', '-s', 'zendesk-plugin', '-a', TOKEN_STORE_ACCOUNT, '-w'],
    ]);
  });

  it('is created with 32 bytes of entropy when the keychain has none', () => {
    const fake = fakeKeychain();
    const key = resolveTokenStoreKey(fake.run);
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(fake.items.get(TOKEN_STORE_ACCOUNT)).toBe(key);
    // -U, so a half-written item from an earlier failed run is replaced instead of colliding.
    expect(fake.calls[1].args).toContain('-U');
  });

  it('is NOT the OAuth client secret, and two creations never collide', () => {
    expect(resolveTokenStoreKey(fakeKeychain().run)).not.toBe(resolveTokenStoreKey(fakeKeychain().run));
  });

  it('refuses a keychain item somebody replaced with something too weak', () => {
    const fake = fakeKeychain({ items: { [TOKEN_STORE_ACCOUNT]: 'short' } });
    expect(() => resolveTokenStoreKey(fake.run)).toThrow(/fewer than 32 bytes of entropy/);
  });

  // The dangerous confusion: a locked or denied keychain answers non-zero too, and creating a second key
  // there would leave every stored token undecryptable with no symptom but a re-login.
  it('does not create a key when the keychain merely could not be read', () => {
    const fake = fakeKeychain({ failRead: { [TOKEN_STORE_ACCOUNT]: 51 } });
    expect(() => resolveTokenStoreKey(fake.run)).toThrow(/could not be read/);
    expect(fake.calls).toHaveLength(1);
    expect(fake.items.size).toBe(0);
  });

  it('reports a write that failed instead of returning a key nothing can decrypt later', () => {
    const fake = fakeKeychain({ failWrite: { [TOKEN_STORE_ACCOUNT]: 45 } });
    expect(() => resolveTokenStoreKey(fake.run)).toThrow(/could not be written to the macOS Keychain/);
  });

  it('fails closed where there is no Keychain at all, naming the issue', () => {
    expect(() => resolveTokenStoreKey(noKeychain)).toThrow(UNSUPPORTED_PLATFORM);
    expect(() => resolveTokenStoreKey(fakeKeychain({ unavailable: true }).run)).toThrow(UNSUPPORTED_PLATFORM);
    expect(UNSUPPORTED_PLATFORM).toContain('#69');
  });

  // The strength gate, lifted from the remote path (src/remote/remote-server.ts:31-36) because #68 may
  // not touch that tree. Same three readings of a key string.
  it('measures entropy as hex, base64 or raw bytes', () => {
    expect(encKeyStrengthBytes('00ff')).toBe(2);
    expect(encKeyStrengthBytes(Buffer.alloc(32).toString('base64'))).toBe(32);
    expect(encKeyStrengthBytes('a key with spaces in it')).toBe(23);
  });
});

// B4: an argv element is readable by `ps` for the lifetime of the call, and these values are the
// customer's client secret and the key to their tokens. `man security`: "-w password … Put at end of
// command to be prompted (recommended)".
describe('every secret this plugin stores', () => {
  it('goes in through stdin, with -w last and nothing in argv', () => {
    const fake = fakeKeychain();
    const key = resolveTokenStoreKey(fake.run);
    writeKeychainConfig(CONFIG, fake.run);

    const secrets = [key, ...Object.values(CONFIG)];
    for (const value of secrets) {
      expect(fake.argv(), `"${value.slice(0, 6)}…" must not be an argument`).not.toContain(value);
    }
    for (const call of fake.calls.filter((c) => c.args[0] === 'add-generic-password')) {
      // -w LAST, which is what makes security prompt instead of taking a value from the command line.
      expect(call.args[call.args.length - 1]).toBe('-w');
      // Twice, because it prompts twice (password, retype). Measured on macOS: one line stores nothing.
      const [first, second, tail] = (call.input ?? '').split('\n');
      expect(first).toBe(second);
      expect(tail).toBe('');
    }
  });

  it('round-trips through the reader that will have to read it back', () => {
    const fake = fakeKeychain();
    writeKeychainConfig(CONFIG, fake.run);
    expect(readKeychainConfig(fake.run)).toEqual(CONFIG);
  });
});

describe('the OAuth configuration in the Keychain', () => {
  it('is read under one service and three accounts, each as an argument array', () => {
    const fake = fakeKeychain({
      items: { 'oauth-subdomain': 'acme', 'oauth-client-id': 'client-abc', 'oauth-client-secret': 'secret-xyz' },
    });
    expect(readKeychainConfig(fake.run)).toEqual(CONFIG);
    expect(fake.calls.map((call) => call.args)).toEqual(
      ACCOUNTS.map((account) => ['find-generic-password', '-s', 'zendesk-plugin', '-a', account, '-w']),
    );
  });

  it('reports a missing item as absent, and a blank one too', () => {
    const fake = fakeKeychain({ items: { 'oauth-client-id': '   ', 'oauth-client-secret': 'secret-xyz' } });
    expect(readKeychainConfig(fake.run)).toEqual({ ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz' });
  });

  it('throws rather than reading as empty when the keychain cannot be opened', () => {
    expect(() => readKeychainConfig(fakeKeychain({ failRead: { 'oauth-subdomain': 51 } }).run)).toThrow(
      /could not be read/,
    );
  });

  it('is simply absent where there is no Keychain, so an env-configured install never depends on it', () => {
    expect(readKeychainConfig(noKeychain)).toEqual({});
  });

  it('is written as three items, replacing what an earlier attempt left behind', () => {
    const fake = fakeKeychain();
    writeKeychainConfig(CONFIG, fake.run);
    const writes = fake.calls.filter((call) => call.args[0] === 'add-generic-password');
    expect(writes.map((call) => call.args.slice(0, 5))).toEqual(
      ACCOUNTS.map((account) => ['add-generic-password', '-s', 'zendesk-plugin', '-a', account]),
    );
    for (const call of writes) expect(call.args).toContain('-U');
    expect([...fake.items.keys()]).toEqual(ACCOUNTS);
  });

  // Exit 0 is not proof. Measured on macOS: with the value on stdin only once, `security`'s retype prompt
  // sees EOF, an EMPTY password is stored and it exits 0 — leaving a configuration that resolves,
  // authorizes nothing, and points at no symptom. So the three are read back before the write returns.
  it('refuses a write the Keychain reported as fine and did not keep', () => {
    const fake = fakeKeychain({ storeAs: { 'oauth-client-secret': '' } });
    expect(() => writeKeychainConfig(CONFIG, fake.run)).toThrow(
      'the macOS Keychain did not keep "oauth-client-secret" as written. Nothing was left behind.',
    );
    expect([...fake.items.keys()]).toEqual([]);
  });

  // B1, the half-written set. A stored pair without the secret RESOLVES — the secret is optional on the
  // code path — so the next start would find the configuration complete, never degrade, and never offer
  // the setup page again: the user would be locked out of their own plugin for good. What is asserted is
  // therefore the state of the Keychain afterwards, not the wording of the failure.
  it('leaves NOTHING behind when a later item cannot be written', () => {
    const fake = fakeKeychain({ failWrite: { 'oauth-client-secret': 45 } });

    expect(() => writeKeychainConfig(CONFIG, fake.run)).toThrow(
      '"oauth-client-secret" could not be written to the macOS Keychain (security exited 45). Nothing was left behind.',
    );

    expect([...fake.items.keys()]).toEqual([]);
    expect(fake.calls.filter((call) => call.args[0] === 'delete-generic-password').map((call) => call.args[4])).toEqual([
      'oauth-subdomain',
      'oauth-client-id',
    ]);
  });

  // And when the rollback itself cannot finish, the one case a person has to clean up by hand, it says
  // which items and where — rather than leaving a set of two and a message that implies none.
  it('names what it could not take back, instead of implying it did', () => {
    const fake = fakeKeychain({ failWrite: { 'oauth-client-secret': 45 }, failDelete: ['oauth-client-id'] });
    expect(() => writeKeychainConfig(CONFIG, fake.run)).toThrow(
      /"oauth-client-id" could not be removed again — delete it under the service "zendesk-plugin" in Keychain Access/,
    );
    expect([...fake.items.keys()]).toEqual(['oauth-client-id']);
  });

  it('names both when both are stuck', () => {
    const fake = fakeKeychain({
      failWrite: { 'oauth-client-secret': 45 },
      failDelete: ['oauth-subdomain', 'oauth-client-id'],
    });
    expect(() => writeKeychainConfig(CONFIG, fake.run)).toThrow(
      /"oauth-subdomain", "oauth-client-id" could not be removed again — delete them under the service/,
    );
  });

  it('names the item but never the value when a write fails', () => {
    const fake = fakeKeychain({ failWrite: { 'oauth-client-id': 45 } });
    let thrown = '';
    try {
      writeKeychainConfig(CONFIG, fake.run);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown).toContain('"oauth-client-id"');
    for (const value of Object.values(CONFIG)) expect(thrown).not.toContain(value);
  });

  it('refuses to write where there is no Keychain, instead of dropping the values somewhere weaker', () => {
    expect(() => writeKeychainConfig(CONFIG, noKeychain)).toThrow(UNSUPPORTED_PLATFORM);
  });
});

// The one function that really starts a process. /bin/echo and friends stand in for `security`, so every
// outcome is MEASURED rather than excluded from coverage — including on Linux, which has no `security`.
describe('the runner that actually starts the process', () => {
  it('reports status 0 and the output of a binary that succeeds', () => {
    const outcome = runSecurity(['hello'], undefined, '/bin/echo');
    expect(outcome.status).toBe(0);
    expect(outcome.output.trim()).toBe('hello');
  });

  it('passes stdin through, which is how every secret gets in', () => {
    expect(runSecurity([], 'on-stdin\n', '/bin/cat').output).toBe('on-stdin\n');
  });

  it('reports the exit status of a binary that refuses', () => {
    expect(runSecurity([], undefined, '/usr/bin/false').status).toBe(1);
  });

  // The distinction the whole platform story rests on: a binary that is NOT THERE is #69, a binary that
  // answered non-zero is "unlock your keychain". ENOENT carries no exit status at all, so without this
  // branch the two would be read as each other.
  it('separates "there is no Keychain here" from "the Keychain said no"', () => {
    expect(runSecurity([], undefined, '/nonexistent/security').status).toBe(KEYCHAIN_UNAVAILABLE);
    expect(noKeychain([]).status).toBe(KEYCHAIN_UNAVAILABLE);
    expect(fakeKeychain({ failRead: { x: 51 } }).run(['find-generic-password', '-s', 's', '-a', 'x']).status).toBe(51);
  });

  // A process killed by a signal has no exit status either, and it is NOT the absence of a Keychain: it
  // must not be answered with "this is not macOS".
  it('does not mistake a process that died on a signal for a missing Keychain', () => {
    const outcome = runSecurity(['-c', 'kill -9 $$'], undefined, '/bin/sh');
    expect(outcome.status).toBe(-2);
    expect(outcome.status).not.toBe(KEYCHAIN_UNAVAILABLE);
  });
});
