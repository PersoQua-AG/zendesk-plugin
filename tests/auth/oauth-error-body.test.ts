import { describe, it, expect } from 'vitest';
import { exchangeCodeForTokens, type OAuthConfig } from '../../src/auth/oauth-flow.js';

// NFR-1 adversarially. summarizeErrorBody (src/auth/oauth-flow.ts:160-166) quotes a token-endpoint
// error body to the user, and the page that made the cap necessary was ~8 KB of Cloudflare
// challenge on ONE line. The rule it implements has exactly two moving parts — "first line, trimmed"
// and "drop it entirely if it starts with `<`" — and both have edges that a happy-path body never
// reaches: a byte-order mark ahead of the `<`, an HTML comment ahead of the `<html>`, a CRLF line
// end, a body sitting exactly on the 200-character cap, and a body whose 200th character is the
// first half of a surrogate pair.
const config: OAuthConfig = {
  subdomain: 'acme',
  clientId: 'client-123',
  clientSecret: 'secret-abc',
  callbackPort: 18976,
  scopes: ['read', 'write'],
};

const OMITTED = 'Token exchange failed: 403 (non-text response body omitted)';

async function messageFor(body: string, status = 403): Promise<string> {
  const fakeFetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
  const outcome = await exchangeCodeForTokens(config, 'c', 'v', 'http://localhost:18976/callback', fakeFetch).then(
    () => null,
    (e: Error) => e,
  );
  expect(outcome, 'a non-ok status must reject, not resolve').not.toBeNull();
  return (outcome as Error).message;
}

// A marker no cut may carry out of the body. In the measured incident its real-world twin was the
// cf_chl_tk challenge token.
const SENTINEL = 'SENTINEL_CHALLENGE_TOKEN';
const page = (lead: string): string => `${lead}<html><body>${'x'.repeat(8000)}${SENTINEL}</body></html>`;

describe('the token-endpoint error body reaching the user', () => {
  // Every one of these is markup whose first non-whitespace character is `<`, however it is dressed.
  it.each([
    ['plain', page('')],
    ['a byte-order mark in front', page('﻿')],
    ['leading spaces and tabs', page('   \t ')],
    ['an HTML comment in front', page('<!-- generated -->')],
    ['a doctype in front', page('<!DOCTYPE html>')],
  ])('drops an HTML page with %s', async (_label, body) => {
    expect(await messageFor(body)).toBe(OMITTED);
  });

  it('keeps only the first line when a CRLF-terminated text line precedes the markup', async () => {
    expect(await messageFor(`invalid_grant\r\n${page('')}`)).toBe('Token exchange failed: 403 invalid_grant');
  });

  // The cap is the second axis, and it is what bounds the damage when markup does NOT lead: a body
  // is quoted, but never more than 200 characters of it, so no 8 KB page can ride out on one line.
  it('caps a single-line body at 200 characters however the markup is buried in it', async () => {
    const buried = `{"error":"invalid_grant","hint":"${'z'.repeat(400)}"}${page('')}`;
    const message = await messageFor(buried);
    expect(message).not.toContain(SENTINEL);
    expect(message).toContain('(truncated)');
    expect(message).toContain('invalid_grant');
    // 'Token exchange failed: 403 ' + 200 + '… (truncated)'
    expect(message).toHaveLength(240);
  });

  it.each([
    [200, false],
    [201, true],
  ])('quotes a %i-character body with truncation=%s', async (length, truncated) => {
    const message = await messageFor('a'.repeat(length));
    expect(message.includes('(truncated)')).toBe(truncated);
    // Nothing is lost below the cap, and nothing above it survives uncut.
    expect(message).toContain('a'.repeat(Math.min(length, 200)));
    expect(message).not.toContain('a'.repeat(201));
  });

  // The cap cuts by UTF-16 code unit, so a 200th character that is the first half of a surrogate
  // pair leaves a lone half behind (measured: 'a'.repeat(199) + '😀' yields one). It is cosmetic —
  // the pair carries no secret and a well-formed JSON.stringify escapes it — so it is reported, not
  // pinned red here. What must hold either way is that nothing past the cap escapes.
  it('never carries content past the cap out, even when the cut lands mid-character', async () => {
    const message = await messageFor(`${'a'.repeat(199)}😀${SENTINEL}`);
    expect(message).not.toContain(SENTINEL);
    expect(message).toContain('(truncated)');
  });
});
