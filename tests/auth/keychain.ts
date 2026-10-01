// tests/auth/keychain.ts
// The macOS Keychain, faked at the ONE seam the production path has: the `security` runner. Everything
// above it — resolveTokenStoreKey, readKeychainConfig, writeKeychainConfig, the env/Keychain merge —
// therefore runs for real in the suite, on any platform, and no case can reach a developer's own login
// keychain. That is not tidiness: CI runs on Linux, where `security` does not exist at all, and on a
// macOS machine the real items hold that person's own Zendesk configuration, so a case driven through
// the real reader would pass or fail by what the person running it had set up. One was created on a
// developer machine before this existed, which is why tests/plugin/no-real-keychain.test.ts now fails
// the build when a test resolves a configuration without passing this.
import {
  CONFIG_ACCOUNTS,
  KEYCHAIN_ABSENT,
  KEYCHAIN_UNAVAILABLE,
  type RunSecurity,
  type SecurityOutcome,
} from '../../src/auth/store-key.js';

export const TOKEN_STORE_ACCOUNT = 'token-store-key';

// Exactly 32 bytes once decoded, so it passes the entropy gate the real reader applies.
export const TEST_STORE_KEY = 'dGVzdC1rZXljaGFpbi1zdG9yZS1rZXktMzJieXRlcyE=';

export interface Call {
  args: string[];
  input?: string;
}

export interface FakeKeychain {
  run: RunSecurity;
  // account → value, as the Keychain would hold it.
  items: Map<string, string>;
  calls: Call[];
  // Every argv element of every call, flattened: what `ps` would have been able to see.
  argv: () => string[];
}

export interface FakeKeychainOptions {
  items?: Record<string, string>;
  // account → the exit status `security` should report instead of succeeding.
  failRead?: Record<string, number>;
  failWrite?: Record<string, number>;
  failDelete?: string[];
  // What the item ends up holding, whatever the write carried: the real `security` stores an EMPTY
  // password and exits 0 when its retype prompt sees EOF, and nothing above the runner can see that
  // except by reading the item back.
  storeAs?: Record<string, string>;
  // No `security` binary at all: what every non-macOS platform looks like.
  unavailable?: boolean;
}

const ok = (output = ''): SecurityOutcome => ({ status: 0, output });
const exits = (status: number): SecurityOutcome => ({ status, output: '' });

export function fakeKeychain(options: FakeKeychainOptions = {}): FakeKeychain {
  const items = new Map(Object.entries(options.items ?? {}));
  const calls: Call[] = [];

  const run: RunSecurity = (args, input) => {
    calls.push({ args, input });
    if (options.unavailable) return exits(KEYCHAIN_UNAVAILABLE);
    const [verb] = args;
    const account = args[args.indexOf('-a') + 1];
    if (verb === 'find-generic-password') {
      const failure = options.failRead?.[account];
      if (failure !== undefined) return exits(failure);
      const value = items.get(account);
      // `security` ends the value with a newline, and the reader has to cope with that.
      return value === undefined ? exits(KEYCHAIN_ABSENT) : ok(`${value}\n`);
    }
    if (verb === 'add-generic-password') {
      const failure = options.failWrite?.[account];
      if (failure !== undefined) return exits(failure);
      // The value arrives on STDIN, never in argv, and `security` prompts twice (password, retype), so
      // it must be there twice. A production change that put it back in argv would store `undefined`
      // here and every round-trip assertion would fail.
      const [value, retyped] = (input ?? '').split('\n');
      if (value === undefined || value !== retyped) return exits(1);
      items.set(account, options.storeAs?.[account] ?? value);
      return ok();
    }
    if (verb === 'delete-generic-password') {
      if (options.failDelete?.includes(account)) return exits(1);
      items.delete(account);
      return ok();
    }
    throw new Error(`the fake Keychain was asked for an unknown verb: ${verb}`);
  };

  return { run, items, calls, argv: () => calls.flatMap((call) => call.args) };
}

// The common case: a Keychain that works and holds a usable token-store key, so nothing is created and
// a test that reads tokens.enc back knows the key.
export function keychain(items: Record<string, string> = {}): RunSecurity {
  return fakeKeychain({ items: { [TOKEN_STORE_ACCOUNT]: TEST_STORE_KEY, ...items } }).run;
}

// A Keychain that holds a complete OAuth configuration — what a machine looks like after setup ran.
export function configuredKeychain(
  config: Partial<Record<keyof typeof CONFIG_ACCOUNTS, string>> = {},
): RunSecurity {
  const values = {
    ZENDESK_SUBDOMAIN: 'stored-sub',
    ZENDESK_OAUTH_CLIENT_ID: 'stored-id',
    ZENDESK_OAUTH_CLIENT_SECRET: 'stored-secret',
    ...config,
  };
  return keychain(
    Object.fromEntries(
      (Object.entries(values) as [keyof typeof CONFIG_ACCOUNTS, string][]).map(([name, value]) => [
        CONFIG_ACCOUNTS[name],
        value,
      ]),
    ),
  );
}

// Locked, or the person clicked "Deny": every read fails with a status that is not "item not found".
export function deniedKeychain(status = 51): RunSecurity {
  return fakeKeychain({
    failRead: Object.fromEntries(
      [TOKEN_STORE_ACCOUNT, ...Object.values(CONFIG_ACCOUNTS)].map((account) => [account, status]),
    ),
  }).run;
}
