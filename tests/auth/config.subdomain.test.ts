import { describe, it, expect } from 'vitest';
import {
  MAX_SUBDOMAIN_LENGTH,
  SUBDOMAIN_RULE,
  resolveAuthConfig,
  stripPlaceholders,
} from '../../src/auth/config.js';
import { buildAuthorizationUrl } from '../../src/auth/oauth-flow.js';
import { buildRemoteApp } from '../../src/remote/remote-server.js';

const withSubdomain = (value: string): NodeJS.ProcessEnv => ({
  ZENDESK_SUBDOMAIN: value,
  ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
  ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
});

const rejection = (echoed: string) =>
  `Invalid environment variable: ZENDESK_SUBDOMAIN="${echoed}" (${SUBDOMAIN_RULE}).`;

// The subdomain is template-interpolated into every Zendesk URL the plugin builds. These four
// values do not produce a broken URL — they produce a DIFFERENT ORIGIN, and the token POST that
// would go there carries client_id, client_secret and refresh_token in its body.
describe('subdomain validation — values that move the origin', () => {
  it.each([
    ['a path separator ends the authority', 'evil.example.com/x', 'https://evil.example.com'],
    ['a fragment ends the authority', 'evil.example.com#', 'https://evil.example.com'],
    ['a query ends the authority', 'evil.example.com?', 'https://evil.example.com'],
    ['an @ turns everything before it into userinfo', 'a@evil.example.com', 'https://evil.example.com.zendesk.com'],
  ])('rejects %s: %s', (_label, value, movedOrigin) => {
    // The escape is real, not hypothetical: this is what the unguarded template produces.
    expect(new URL(`https://${value}.zendesk.com/oauth/tokens`).origin).toBe(movedOrigin);
    expect(() => resolveAuthConfig(withSubdomain(value))).toThrow(rejection(value));
  });

  it.each([
    ['a full host instead of the subdomain', 'acme.zendesk.com'],
    ['a pasted URL', 'https://acme.zendesk.com'],
    ['a dot of any kind — it would add a label', 'acme.eu'],
    ['an underscore, which Zendesk names as not allowed', 'acme_eu'],
    ['a colon, which could carry a port', 'acme:8080'],
    ['a backslash, which some URL parsers treat as a separator', 'evil.example.com\\x'],
    ['a percent escape', 'acme%2f'],
    ['an inner space', 'ac me'],
    ['only whitespace — trimmed to nothing', '   '],
  ])('rejects %s: %s', (_label, value) => {
    expect(() => resolveAuthConfig(withSubdomain(value))).toThrow(rejection(value.trim()));
  });

  it(`rejects a value one character past the ${MAX_SUBDOMAIN_LENGTH}-character DNS label limit`, () => {
    const tooLong = 'a'.repeat(MAX_SUBDOMAIN_LENGTH + 1);
    expect(() => resolveAuthConfig(withSubdomain(tooLong))).toThrow(rejection(tooLong));
  });

  it('names the user_config field, not the env var alone, and gives the worked example', () => {
    expect(SUBDOMAIN_RULE).toContain('"zendesk_subdomain"');
    expect(SUBDOMAIN_RULE).toContain('acme.zendesk.com');
    expect(SUBDOMAIN_RULE).toContain(String(MAX_SUBDOMAIN_LENGTH));
  });
});

// The other half of the rule: a guard that rejects legitimate customers is a bug, not a fix. Every
// value here is one Zendesk's own documented rule allows.
describe('subdomain validation — values that must keep working', () => {
  it.each([
    ['the ordinary case', 'acme'],
    ['a dash inside', 'acme-support'],
    ['several dashes', 'a-b-c-d'],
    ['digits', 'acme2024'],
    ['a leading digit', '2acme'],
    ['uppercase — Zendesk documents A-Z', 'ACME'],
    ['mixed case', 'AcmeSupport'],
    ['a single character, below the documented rename minimum of 3', 'a'],
    ['two characters, likewise', 'ab'],
    ['a leading dash — Zendesk states no rule against it', '-acme'],
    ['a trailing dash — likewise', 'acme-'],
    ['exactly the DNS label limit', 'a'.repeat(MAX_SUBDOMAIN_LENGTH)],
  ])('accepts %s: %s', (_label, value) => {
    expect(resolveAuthConfig(withSubdomain(value)).config.subdomain).toBe(value);
  });

  it('trims surrounding whitespace rather than rejecting it — a copy-paste artifact, not an opinion', () => {
    expect(resolveAuthConfig(withSubdomain('  acme  ')).config.subdomain).toBe('acme');
    expect(resolveAuthConfig(withSubdomain('acme\n')).config.subdomain).toBe('acme');
  });

  // An absent/blank required field must still fail as MISSING, naming the empty field — not as
  // invalid. stripPlaceholders makes an untouched optional field absent; subdomain is required, so
  // the placeholder must reach the missing-field error, which is the one that says "is empty".
  it.each([
    ['blank', ''],
    ['an unsubstituted placeholder', '${user_config.zendesk_subdomain}'],
  ])('still reports %s as missing, not as invalid', (_label, value) => {
    const env = withSubdomain(value);
    expect(stripPlaceholders(env).ZENDESK_SUBDOMAIN ?? '').not.toBe('${user_config.zendesk_subdomain}');
    expect(() => resolveAuthConfig(env)).toThrow(
      'Missing required environment variable: ZENDESK_SUBDOMAIN (extension configuration field "zendesk_subdomain" is empty).',
    );
  });

  // The point of the guard, stated as the property it buys: whatever survives resolveAuthConfig can
  // only ever build a URL on the account's own zendesk.com host.
  it('leaves every accepted value unable to move the authorization URL off zendesk.com', () => {
    for (const value of ['acme', '-acme', 'acme-', 'ACME', '2acme', 'a'.repeat(MAX_SUBDOMAIN_LENGTH)]) {
      const { config } = resolveAuthConfig(withSubdomain(value));
      const url = new URL(buildAuthorizationUrl(config, 'challenge', 'state'));
      expect(url.origin.toLowerCase()).toBe(`https://${value.toLowerCase()}.zendesk.com`);
      expect(url.hostname.toLowerCase().endsWith('.zendesk.com')).toBe(true);
    }
  });
});

// The remote bridge resolves the SAME config and builds the same host into the same URLs
// (remote-server.ts:72 -> resolveAuthConfig, then remote/zendesk-identity.ts:15). The guard is
// wanted there too, and it lands there for free — asserted rather than assumed, because
// buildRemoteApp is the one caller that could have been given its own resolution path.
describe('subdomain validation reaches the remote path too', () => {
  it('refuses to build the remote app on a subdomain that would move the origin', () => {
    expect(() => buildRemoteApp(withSubdomain('evil.example.com/x'))).toThrow(
      rejection('evil.example.com/x'),
    );
  });
});
