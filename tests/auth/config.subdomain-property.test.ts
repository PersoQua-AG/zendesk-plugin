import { describe, it, expect } from 'vitest';
import { resolveAuthConfig } from '../../src/auth/config.js';
import { buildAuthorizationUrl } from '../../src/auth/oauth-flow.js';
import { keychain } from './keychain.js';

// The subdomain guard has exactly ONE property worth having, and a list of example values cannot
// state it: whatever resolveAuthConfig accepts must be unable to move a plugin URL off the
// account's own <subdomain>.zendesk.com host. Everything else — which characters, what maximum
// length, whether a leading dash is allowed — is a policy argument. This file tests the property
// over a generated input space instead, so a future loosening of the rule is measured against the
// thing that matters rather than against the examples somebody happened to think of.

const env = (subdomain: string): NodeJS.ProcessEnv => ({
  ZENDESK_SUBDOMAIN: subdomain,
  ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
  ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
});

// Seeded so a failure is reproducible: a property test that generates a fresh input space on every
// run reports a defect that the next run cannot show.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deliberately weighted toward what breaks a URL authority rather than toward what looks like a
// subdomain. The homoglyphs are the ones a character-class guard is actually at risk from: U+FF0E,
// U+3002 and U+FF61 are all mapped to '.' by IDNA, U+212A case-folds toward 'K' and U+017F toward
// 's', and U+202E reorders what a human reviewer reads without changing what the parser sees.
const ALPHABET = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-',
  ...'./\\@#?:%&=+ ,;\'"*!()[]{}|^~`$_',
  '\u0000', '\t', '\n', '\r', '', '', '',
  '．', '。', '｡', // IDNA-mapped full stops
  'K', 'ſ',           // case-folding homoglyphs for K and s
  'ａ', 'ｅ',           // fullwidth a, e
  '‮', '​', '­', // bidi override, zero-width space, soft hyphen
  'а',                     // Cyrillic a
  'xn--', 'evil.example.com', '%2f', '%00',
];

function candidate(rnd: () => number): string {
  const len = 1 + Math.floor(rnd() * 12);
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
  return out;
}

// "Did not move" stated the only way a URL parser can be asked it: the host the request would go to
// is <label>.zendesk.com and nothing else. A URL that cannot be constructed at all also cannot move
// anywhere — no request is made — so it satisfies the property loudly.
function staysOnTheAccountHost(subdomain: string): boolean {
  let host: string;
  try {
    host = new URL(`https://${subdomain}.zendesk.com/oauth/tokens`).hostname;
  } catch {
    return true;
  }
  const labels = host.split('.');
  return labels.length === 3 && labels[1] === 'zendesk' && labels[2] === 'com' && labels[0].length > 0;
}

describe('subdomain guard — the property, over a generated input space', () => {
  it('never accepts a value that could move a plugin URL off <subdomain>.zendesk.com', () => {
    const rnd = mulberry32(20260916);
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 5_000; i += 1) {
      const value = candidate(rnd);
      let resolved: string | undefined;
      try {
        resolved = resolveAuthConfig(env(value), keychain()).config.subdomain;
      } catch {
        rejected += 1;
        continue;
      }
      accepted += 1;
      expect(staysOnTheAccountHost(resolved), `accepted subdomain ${JSON.stringify(value)} moved the host`).toBe(true);
    }
    // Not vacuous in either direction: an input space that is rejected wholesale would prove nothing
    // about the accepting branch, and one that is accepted wholesale would not be adversarial.
    expect(accepted, 'generator produced no accepted values').toBeGreaterThan(50);
    expect(rejected, 'generator produced no rejected values').toBeGreaterThan(500);
  });

  // Control: the same generator, the same 5000 inputs, WITHOUT the guard. If this did not find an
  // escape, the case above would be passing because the generator never reaches the dangerous
  // space — the precise way a property test passes for the wrong reason.
  it('finds escapes on the same inputs when the guard is not applied — so the case above is not vacuous', () => {
    const rnd = mulberry32(20260916);
    const escaped: string[] = [];
    for (let i = 0; i < 5_000; i += 1) {
      const value = candidate(rnd);
      if (!staysOnTheAccountHost(value)) escaped.push(value);
    }
    expect(escaped.length, 'the generator never reached a host-moving value').toBeGreaterThan(100);
  });

  // The named attacks, stated once as values rather than left to the generator to stumble on.
  it.each([
    ['a fullwidth full stop, which IDNA maps to "."', 'evil.example.com．acme'],
    ['an ideographic full stop, likewise', 'evil。example。com'],
    ['a halfwidth ideographic full stop, likewise', 'evil｡example｡com'],
    ['a Kelvin sign, which case-folds toward K', 'acKe'],
    ['a long s, which case-folds toward s', 'acmeſ'],
    ['a fullwidth a', 'ａcme'],
    ['a Cyrillic a', 'аcme'],
    ['a bidi override that hides the real order from a reader', 'acme‮moc.elpmaxe.live'],
    ['a zero-width space', 'ac​me'],
    ['a soft hyphen, which IDNA deletes', 'ac­me'],
    ['a NUL byte', 'acme\u0000.evil.example.com'],
    ['a percent-encoded slash', 'acme%2fevil.example.com'],
    ['a percent-encoded NUL', 'acme%00'],
    ['a tab, which the URL parser strips', 'acme\tevil.example.com'],
    ['a newline, likewise', 'acme\nevil.example.com'],
    ['a carriage return, likewise', 'acme\revil.example.com'],
    ['64 characters — one past the DNS label limit', 'a'.repeat(64)],
    ['a very long value', 'a'.repeat(10_000)],
    ['a very long value made of legal characters and one dot', `${'a'.repeat(200)}.evil.example.com`],
  ])('rejects %s', (_label, value) => {
    expect(() => resolveAuthConfig(env(value), keychain())).toThrow(/ZENDESK_SUBDOMAIN/);
  });

  // The residual the character set leaves open, now closed: an "xn--" prefix is letters and dashes,
  // so the rule accepts it, but it marks an internationalized (punycode) label that new URL()
  // refuses when it does not decode. It was never an origin defect — the value still stays on the
  // account host — it was a MESSAGE defect: the value reached buildAuthorizationUrl and the user
  // was told "Zendesk login failed: Invalid URL. Run zendesk_login again once that is resolved.",
  // which names no field and asks for a retry that can never succeed. It now fails at startup,
  // naming ZENDESK_SUBDOMAIN.
  it.each([
    ['the bare prefix', 'xn--'],
    ['a prefix with a payload that does not decode', 'xn--acme'],
    ['a prefix with a digit payload', 'xn--1'],
  ])('rejects an xn-- value that is not a host name at all: %s', (_label, value) => {
    // Still not an origin defect — asserted before the rejection, so the two claims stay separate.
    expect(staysOnTheAccountHost(value)).toBe(true);
    expect(() => resolveAuthConfig(env(value), keychain())).toThrow(/ZENDESK_SUBDOMAIN/);
    expect(() => resolveAuthConfig(env(value), keychain())).toThrow(/"zendesk_subdomain"/);
  });

  // The other half of that choice, and the reason the prefix itself is not refused: a REAL punycode
  // subdomain decodes, and a customer may hold one. "xn--bcher-kva" is "bücher". Rejecting the
  // prefix would have locked them out; forming the URL states the property instead.
  it('keeps a valid punycode subdomain working', () => {
    const { config } = resolveAuthConfig(env('xn--bcher-kva'), keychain());
    expect(config.subdomain).toBe('xn--bcher-kva');
    expect(new URL(buildAuthorizationUrl(config, 'challenge', 'state')).hostname).toBe(
      'xn--bcher-kva.zendesk.com',
    );
  });

  // The same property through the function that actually builds the URL, for the values the rule
  // documents as legal — the guard is worthless if it is enforced somewhere the URL is not built.
  it('holds through buildAuthorizationUrl for every documented-legal shape', () => {
    for (const value of ['a', 'ab', 'acme', 'ACME', '2acme', 'a-b-c', '-acme', 'acme-', 'a'.repeat(63)]) {
      const { config } = resolveAuthConfig(env(value), keychain());
      const url = new URL(buildAuthorizationUrl(config, 'challenge', 'state'));
      expect(url.hostname).toBe(`${value.toLowerCase()}.zendesk.com`);
      expect(url.username).toBe('');
      expect(url.port).toBe('');
    }
  });
});
