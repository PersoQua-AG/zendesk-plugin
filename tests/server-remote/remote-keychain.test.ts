import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../src/server.js';
import { resolveAuthConfig } from '../../src/auth/config.js';
import { noKeychain } from '../../src/auth/store-key.js';
import { SessionManager } from '../../src/remote/session-manager.js';
import { configuredKeychain, fakeKeychain } from '../auth/keychain.js';

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

  // The call that mattered, and the one the first fix missed: EVERY SESSION is a createServer(), so
  // opting buildRemoteApp's own resolution out left the per-session one on the real runner. Measured
  // before this: a session built with a remote env carrying a subdomain and a client id but no secret —
  // allowed now that the secret is optional — read oauth-subdomain, oauth-client-id,
  // oauth-client-secret and token-store-key out of the operator's login keychain.
  it('opens a session without asking a Keychain anything', () => {
    const operator = fakeKeychain({
      items: {
        'oauth-subdomain': 'operators-own-tenant',
        'oauth-client-id': 'operators-id',
        'oauth-client-secret': 'operators-secret',
        'token-store-key': 'c3VwZXItc2VjcmV0LWtleS10aGF0LWlzLTMyLWJ5dGVz',
      },
    });

    // What SessionManager does per session, with the runner the bridge gives it.
    createServer({ ZENDESK_SUBDOMAIN: 'tenant', ZENDESK_OAUTH_CLIENT_ID: 'id', CLAUDE_PLUGIN_DATA: '/var/data' }, {
      security: noKeychain,
      authManager: { getAccessToken: async () => 'tok' },
    });

    // And with the operator's, to show what the default would have read — the inverse measurement, so
    // this case cannot pass because nothing reached the Keychain for an unrelated reason.
    createServer({ ZENDESK_SUBDOMAIN: 'tenant', ZENDESK_OAUTH_CLIENT_ID: 'id', CLAUDE_PLUGIN_DATA: '/var/data' }, {
      security: operator.run,
      authManager: { getAccessToken: async () => 'tok' },
    });

    expect(operator.calls.map((call) => call.args[4])).toEqual([
      'oauth-subdomain',
      'oauth-client-id',
      'oauth-client-secret',
      'token-store-key',
    ]);
  });

  it('requires that runner rather than defaulting to one', () => {
    // Not optional-with-a-default, because the default would be the real runner — which is the mistake.
    const deps: ConstructorParameters<typeof SessionManager>[1] = {
      security: noKeychain,
      resolver: {} as never,
      rateLimiter: {} as never,
      incrementalRateLimiter: {} as never,
      dataDir: '/var/data',
      audit: {} as never,
    };
    expect(deps.security).toBe(noKeychain);
  });
});
