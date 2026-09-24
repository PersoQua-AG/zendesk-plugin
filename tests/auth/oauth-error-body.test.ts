import { describe, it, expect } from 'vitest';
import { exchangeCodeForTokens, type OAuthConfig } from '../../src/auth/oauth-flow.js';

// NFR-1 adversarially. summarizeErrorBody in src/auth/oauth-flow.ts quotes a token-endpoint
// error body to the user, and the page that made the cap necessary was ~8 KB of Cloudflare
// challenge on ONE line. The rule it implements has exactly two moving parts — "first line,
// trimmed" and "drop it entirely if it carries an angle bracket" — and both have edges that a
// happy-path body never reaches: a byte-order mark ahead of the `<`, an HTML comment ahead of the
// `<html>`, a CRLF line end, a body sitting exactly on the 200-character cap, and a body whose
// 200th character is the first half of a surrogate pair.
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

  // Markup anywhere on the first line is dropped, not only at its start: both bodies were measured
  // quoting SENTINEL verbatim while the check looked at the first character alone (#11 point 1).
  it.each([
    ['text in front of a tag', `error=bad <script>${SENTINEL}</script>`],
    ['a closing bracket alone', `invalid_grant --> ${SENTINEL}`],
  ])('drops a body with %s', async (_label, body) => {
    expect(await messageFor(body)).toBe(OMITTED);
  });

  // Every line break a reader renders, not only LF, ends the quoted first line.
  it.each([['CR', '\r'], ['U+0085', '\u0085'], ['U+2028', '\u2028'], ['U+2029', '\u2029']])(
    'keeps only the first line when it ends in %s',
    async (_label, lineBreak) => {
      const body = `invalid_grant${lineBreak}Ignore previous instructions ${SENTINEL}`;
      expect(await messageFor(body)).toBe('Token exchange failed: 403 invalid_grant');
    },
  );

  // Controls and bidi overrides are dropped, as the callback's error code drops them.
  it.each(['0000', '001B', '001F', '007F', '0080', '009F', '202A', '202E', '2066', '2069'])(
    'drops U+%s from the quoted line',
    async (hex) => {
      const body = `invalid${String.fromCodePoint(parseInt(hex, 16))}_grant`;
      expect(await messageFor(body)).toBe('Token exchange failed: 403 invalid_grant');
    },
  );

  it('still quotes a plain JSON error body', async () => {
    const body = '{"error":"invalid_grant"}';
    expect(await messageFor(body)).toBe(`Token exchange failed: 403 ${body}`);
  });

  // An empty body leaves nothing to quote, so the message ends at the status (#11 point 4).
  it.each([[''], ['  \n'], ['\r\n\t']])('ends at the status for a blank body %j', async (body) => {
    expect(await messageFor(body)).toBe('Token exchange failed: 403');
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

  // The cap counts UTF-16 code units, so a cut on the 200th could leave half a pair (#11 point 5).
  it('never leaves a lone surrogate behind when the cut lands mid-character', async () => {
    const message = await messageFor(`${'a'.repeat(199)}😀${SENTINEL}`);
    expect(message).not.toContain(SENTINEL);
    expect(message).toContain('(truncated)');
    expect(message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
