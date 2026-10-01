import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAuthConfig } from '../../src/auth/config.js';
import { noKeychain } from '../../src/auth/store-key.js';
import { configuredKeychain } from '../auth/keychain.js';

// #68 B5. This process serves OTHER PEOPLE. The stdio plugin reads a first-run configuration out of the
// login keychain by design; a bridge must not, because on a macOS host with an incomplete env it would
// have served every remote user from the OPERATOR's own personal OAuth client — their instance, their
// client id, their secret — with nothing in the logs to say so.
//
// Two halves, because the mechanism and the wiring are different claims: what the seam DOES is asserted
// by running it, and that the bridge passes it is asserted on the one line that does.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const incompleteEnv = { ZENDESK_OAUTH_CLIENT_ID: 'bridge-id', CLAUDE_PLUGIN_DATA: '/var/data' };

describe('the remote bridge and the login keychain', () => {
  it('reads nothing from a Keychain when it is handed noKeychain', () => {
    // The same env, the same stored configuration, two seams: one fills the gaps from the Keychain, the
    // other refuses to look. That difference is the whole fix.
    expect(resolveAuthConfig(incompleteEnv, configuredKeychain()).config.subdomain).toBe('stored-sub');
    expect(() => resolveAuthConfig(incompleteEnv, noKeychain)).toThrow(
      /Missing required environment variable: ZENDESK_SUBDOMAIN/,
    );
  });

  it('is the seam the bridge actually passes', () => {
    const source = readFileSync(join(ROOT, 'src', 'remote', 'remote-server.ts'), 'utf8');
    expect(source).toContain('resolveAuthConfig(env, noKeychain)');
    // And no other resolution in that tree quietly takes the default.
    for (const match of source.matchAll(/resolveAuthConfig\(([^)]*)\)/g)) {
      expect(match[1], 'every remote resolution must opt out of the Keychain').toContain('noKeychain');
    }
  });
});
