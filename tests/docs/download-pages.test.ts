// web/install-guide.html is a SHIPPED artifact: it is handed to a colleague next to the .mcpb and
// opened in a browser. Three things about it can be checked without pinning its prose, and pinning
// its prose is what the earlier version of this file got wrong — it froze a page that then had to
// change, while measurably failing to hold the statements that actually matter (five critical
// sentences removed, all cases still green). What is left are the properties that stay true however
// the page is worded.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const PAGE = 'web/install-guide.html';
const page = read(PAGE);
const manifest = JSON.parse(read('manifest.json'));

describe('the page carries no secret and no internal address', () => {
  // Same rules as scripts/audit-bundle.mjs applies to the bundle, and for the same reason: this file
  // is distributed. A finding names the RULE and never the matched value.
  const CREDENTIAL_PATTERNS: { rule: string; re: RegExp }[] = [
    { rule: 'private-key-block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
    { rule: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
    { rule: 'json-web-token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
    { rule: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
    {
      rule: 'credential-assignment',
      re: /(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|passwd|secret|token)["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i,
    },
    { rule: 'basic-auth-url', re: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/ },
    { rule: 'zendesk-api-token-pair', re: /\/token:[A-Za-z0-9]{20,}/ },
    // The tenant NAME belongs on the page — it is the value that goes in the field, and it is not a
    // secret. The full host does not: it turns a field value into a working address.
    { rule: 'zendesk-host', re: /[a-z0-9-]+\.zendesk\.com\b/i },
    { rule: 'ip-address', re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  ];

  for (const { rule, re } of CREDENTIAL_PATTERNS) {
    it(`is clean of ${rule}`, () => {
      expect(re.test(page) ? `${PAGE} [${rule}]` : null).toBeNull();
    });
  }
});

describe('the page renders offline, with nothing fetched from anywhere', () => {
  // It is opened from a local file. Anything it reaches for is a broken page on a train, and a
  // record of who read it everywhere else.
  const EXTERNAL: { rule: string; re: RegExp }[] = [
    { rule: 'script-src', re: /<script[^>]*\ssrc\s*=/i },
    { rule: 'stylesheet-link', re: /<link[^>]*\srel\s*=\s*["']?stylesheet/i },
    { rule: 'css-import', re: /@import\b/i },
    { rule: 'css-url', re: /url\(\s*["']?(?!data:)[^)]/i },
    { rule: 'remote-attribute', re: /\b(?:src|href|action|poster|srcset|data|formaction)\s*=\s*["'](?:https?:)?\/\//i },
    { rule: 'iframe-or-embed', re: /<(?:iframe|embed|object|video|audio|img)\b/i },
  ];

  for (const { rule, re } of EXTERNAL) {
    it(`pulls no external resource (${rule})`, () => {
      expect(re.test(page) ? `${PAGE} [${rule}]` : null).toBeNull();
    });
  }

  it('is a complete standalone document', () => {
    expect(page.trimStart().startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('</html>');
  });
});

describe('the page names the file the release actually produces', () => {
  // scripts/audit-bundle.mjs emits `zendesk-<version>.mcpb` and refuses to emit anything when
  // manifest.json and package.json disagree. A page naming last release's file points at a file
  // nobody has — and that is the one fact on it that goes stale on its own.
  const version: string = manifest.version;

  it('manifest.json and package.json agree on the version', () => {
    expect(JSON.parse(read('package.json')).version).toBe(version);
  });

  it(`names zendesk-${version}.mcpb`, () => {
    expect(page).toContain(`zendesk-${version}.mcpb`);
  });
});
