// tests/setup/no-real-keychain.ts — a vitest globalSetup, i.e. the ONE hook that runs after every test
// file has finished.
//
// The static guard in tests/plugin/no-real-keychain.test.ts reads source and therefore cannot see a
// SPAWNED child: tests/plugin/self-contained-server.test.ts starts the real dist/plugin/server.js, and for
// a while that child created the real `zendesk-plugin` Keychain item on every run of the suite. No amount
// of parsing finds that. This does, by looking at the machine.
//
// It compares BEFORE with AFTER rather than demanding an empty keychain: a developer who has actually run
// the first-run setup legitimately holds these items, and a suite that failed for that would be punishing
// the one person it is supposed to protect. What fails the run is the suite CREATING one.
//
// Off macOS there is no `security` binary at all, so both lists are empty and this is inert — which is
// also why it cannot stand in for the static guard: CI would never notice.
import { execFileSync } from 'node:child_process';

const SERVICE = 'zendesk-plugin';
const ACCOUNTS = ['token-store-key', 'oauth-subdomain', 'oauth-client-id', 'oauth-client-secret'];

function present(): string[] {
  return ACCOUNTS.filter((account) => {
    try {
      execFileSync('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', account], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return true;
    } catch {
      // Not there, or there is no Keychain here at all. Either way: nothing of ours.
      return false;
    }
  });
}

export function setup(): () => void {
  const before = present();
  return () => {
    const created = present().filter((account) => !before.includes(account));
    if (created.length > 0) {
      throw new Error(
        `the suite created ${created.map((a) => `"${SERVICE}/${a}"`).join(', ')} in the real login keychain. ` +
          'Every test must reach the Keychain through the fake runner in tests/auth/keychain.ts; a test that ' +
          'SPAWNS the plugin has to spawn it in a state that needs no key at all ' +
          '(tests/plugin/self-contained-server.test.ts shows the shape). Delete the item(s) and fix the test.',
      );
    }
  };
}
