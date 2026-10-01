import { describe, it, expect } from 'vitest';
import {
  CONFIG_ACCOUNTS,
  encKeyStrengthBytes,
  keychainAvailable,
  readKeychainConfig,
  resolveTokenStoreKey,
  runSecurity,
  UNSUPPORTED_PLATFORM,
  writeKeychainConfig,
  type SecurityOutcome,
} from '../../src/auth/store-key.js';

const EXISTING = 'FQ2wLxN0Yk8pR7vS1tU3aB5cD6eF8gH9iJ0kL2mN4oQ=';

// What `security` exits with when the item is not in the keychain. The whole point of distinguishing
// it is below: any OTHER failure must not be read as "no key yet".
const ITEM_NOT_FOUND = 44;

function recorder(outcomes: SecurityOutcome[]): { run: (args: string[]) => SecurityOutcome; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push(args);
      return outcomes[calls.length - 1] ?? { status: 0, output: '' };
    },
  };
}

describe('the token-store key', () => {
  it('is read from the login keychain by service and account, as an argument ARRAY', () => {
    const { run, calls } = recorder([{ status: 0, output: `${EXISTING}\n` }]);
    expect(resolveTokenStoreKey('darwin', run)).toBe(EXISTING);
    // Not a shell string: every value the key source passes is its own argv element, so nothing here
    // can be word-split, globbed or interpreted by a shell.
    expect(calls).toEqual([['find-generic-password', '-s', 'zendesk-plugin', '-a', 'token-store-key', '-w']]);
  });

  it('is created once, with 32 bytes of entropy, when the keychain has none', () => {
    const { run, calls } = recorder([{ status: ITEM_NOT_FOUND, output: '' }, { status: 0, output: '' }]);
    const key = resolveTokenStoreKey('darwin', run);

    expect(calls[1].slice(0, 5)).toEqual(['add-generic-password', '-s', 'zendesk-plugin', '-a', 'token-store-key']);
    expect(calls[1][5]).toBe('-w');
    expect(calls[1][6]).toBe(key);
    // -U, so a half-written item from an earlier failed run is replaced instead of colliding.
    expect(calls[1][7]).toBe('-U');
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
  });

  it('is NOT the OAuth client secret, and two creations never collide', () => {
    const first = resolveTokenStoreKey('darwin', recorder([{ status: ITEM_NOT_FOUND, output: '' }]).run);
    const second = resolveTokenStoreKey('darwin', recorder([{ status: ITEM_NOT_FOUND, output: '' }]).run);
    expect(first).not.toBe(second);
  });

  it('refuses a keychain item somebody replaced with something too weak', () => {
    const { run } = recorder([{ status: 0, output: 'short\n' }]);
    expect(() => resolveTokenStoreKey('darwin', run)).toThrow(/fewer than 32 bytes of entropy/);
  });

  // The dangerous confusion: a locked keychain answers non-zero too, and creating a second key there
  // would leave every stored token undecryptable with no symptom but a re-login.
  it('does not create a key when the keychain merely could not be read', () => {
    const { run, calls } = recorder([{ status: 1, output: '' }]);
    expect(() => resolveTokenStoreKey('darwin', run)).toThrow(/could not be read/);
    expect(calls).toHaveLength(1);
  });

  it('reports a write that failed instead of returning a key nothing can decrypt later', () => {
    const { run } = recorder([{ status: ITEM_NOT_FOUND, output: '' }, { status: 45, output: '' }]);
    expect(() => resolveTokenStoreKey('darwin', run)).toThrow(/could not be written to the macOS Keychain/);
  });

  it.each(['linux', 'win32'] as const)('fails closed on %s and names the issue, with no weaker fallback', (platform) => {
    expect(() => resolveTokenStoreKey(platform)).toThrow(UNSUPPORTED_PLATFORM);
    expect(UNSUPPORTED_PLATFORM).toContain('#69');
  });

  // The strength gate, lifted from the remote path (src/remote/remote-server.ts:31-36) because #68
  // may not touch that tree. Same three readings of a key string.
  it('measures entropy as hex, base64 or raw bytes', () => {
    expect(encKeyStrengthBytes('00ff')).toBe(2);
    expect(encKeyStrengthBytes(Buffer.alloc(32).toString('base64'))).toBe(32);
    expect(encKeyStrengthBytes('a key with spaces in it')).toBe(23);
  });
});

describe('the runner that actually starts the process', () => {
  it('reports status 0 and the output of a binary that succeeds', () => {
    const outcome = runSecurity(['hello'], '/bin/echo');
    expect(outcome.status).toBe(0);
    expect(outcome.output.trim()).toBe('hello');
  });

  it('reports a non-zero status, and -1 when there is no status at all', () => {
    expect(runSecurity([], '/usr/bin/false').status).toBe(1);
    // No such binary: ENOENT carries no exit status, and -1 is not 44, so it can never be mistaken
    // for "the item is not there" — which is exactly the non-macOS case.
    expect(runSecurity([], '/nonexistent/security').status).toBe(-1);
  });
});

// The three values the first-run setup page collects. They are in the Keychain beside the store key by
// owner decision: the client id is internal, and the instance name is not to lie around either.
describe('the OAuth configuration in the Keychain', () => {
  const CONFIG = {
    ZENDESK_SUBDOMAIN: 'acme',
    ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
    ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
  };

  it('is read under one service and three accounts, each as an argument array', () => {
    const { run, calls } = recorder([
      { status: 0, output: 'acme\n' },
      { status: 0, output: 'client-abc\n' },
      { status: 0, output: 'secret-xyz\n' },
    ]);
    expect(readKeychainConfig('darwin', run)).toEqual(CONFIG);
    expect(calls).toEqual([
      ['find-generic-password', '-s', 'zendesk-plugin', '-a', 'oauth-subdomain', '-w'],
      ['find-generic-password', '-s', 'zendesk-plugin', '-a', 'oauth-client-id', '-w'],
      ['find-generic-password', '-s', 'zendesk-plugin', '-a', 'oauth-client-secret', '-w'],
    ]);
  });

  it('reports a missing item as absent, and a blank one too', () => {
    const { run } = recorder([
      { status: ITEM_NOT_FOUND, output: '' },
      { status: 0, output: '   \n' },
      { status: 0, output: 'secret-xyz\n' },
    ]);
    expect(readKeychainConfig('darwin', run)).toEqual({ ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz' });
  });

  // The dangerous one: answering "nothing is stored" for a keychain that merely could not be opened
  // would send a configured user back through setup and overwrite what is in there.
  it('throws rather than reading as empty when the keychain cannot be opened', () => {
    const { run } = recorder([{ status: 51, output: '' }]);
    expect(() => readKeychainConfig('darwin', run)).toThrow(/could not be read/);
  });

  it('is simply absent off macOS, so an env-configured install is never made to depend on it', () => {
    const { run, calls } = recorder([]);
    expect(readKeychainConfig('linux', run)).toEqual({});
    expect(calls).toEqual([]);
    expect(keychainAvailable('linux')).toBe(false);
    expect(keychainAvailable('darwin')).toBe(true);
  });

  it('is written as three items, replacing what an earlier attempt left behind', () => {
    const { run, calls } = recorder([]);
    writeKeychainConfig(CONFIG, 'darwin', run);
    expect(calls.map((args) => args.slice(0, 5))).toEqual(
      Object.values(CONFIG_ACCOUNTS).map((account) => ['add-generic-password', '-s', 'zendesk-plugin', '-a', account]),
    );
    for (const args of calls) {
      expect(args[5]).toBe('-w');
      expect(args[7]).toBe('-U');
    }
    expect(calls.map((args) => args[6])).toEqual(['acme', 'client-abc', 'secret-xyz']);
  });

  it('names the item but never the value when a write fails', () => {
    const { run } = recorder([{ status: 0, output: '' }, { status: 45, output: '' }]);
    expect(() => writeKeychainConfig(CONFIG, 'darwin', run)).toThrow(
      '"oauth-client-id" could not be written to the macOS Keychain (security exited 45).',
    );
    expect(() => writeKeychainConfig(CONFIG, 'darwin', recorder([{ status: 0, output: '' }, { status: 45, output: '' }]).run)).not.toThrow(
      /client-abc/,
    );
  });

  it('refuses to write off macOS instead of dropping the values somewhere weaker', () => {
    expect(() => writeKeychainConfig(CONFIG, 'linux', recorder([]).run)).toThrow(UNSUPPORTED_PLATFORM);
  });
});
