// The two pages under web/ are SHIPPED artifacts: they sit next to the .mcpb on the download page
// and are read by a colleague who has no terminal, no repo and nobody looking over their shoulder.
// "The guide is understandable" is not a check, so these are the checks that exist instead — each
// one turns a promise the pages make into something that can go red.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const INSTALL = 'web/install-guide.html';
const RUNBOOK = 'web/admin-runbook.html';
const PAGES = [INSTALL, RUNBOOK];

const installPage = read(INSTALL);
const runbookPage = read(RUNBOOK);
const manifest = JSON.parse(read('manifest.json'));

describe('the colleague page covers the configuration dialog', () => {
  // Read from the manifest, never listed here by hand: the dialog a colleague fills in IS
  // manifest.user_config, so a tenth key added there must turn this red instead of silently
  // shipping a page that leaves one field unexplained. The title is what the check looks for
  // because the title is what the colleague sees on screen — the key name never appears in the UI.
  const entries = Object.entries(manifest.user_config as Record<string, { title: string }>);

  it('declares all nine keys, so the loop below is not checking an empty set', () => {
    expect(entries).toHaveLength(9);
  });

  for (const [key, field] of entries) {
    it(`names the field for ${key} ("${field.title}")`, () => {
      expect(installPage).toContain(field.title);
    });
  }

  it('marks exactly the three required fields as required', () => {
    const required = entries.filter(([, f]) => (f as { required?: boolean }).required).map(([k]) => k);
    expect(required).toEqual(['zendesk_subdomain', 'oauth_client_id', 'oauth_client_secret']);
    // Three cells carrying the required marker, one per required field.
    expect(installPage.match(/class="req"/g) ?? []).toHaveLength(3);
  });

  it('states the callback-port default and its bounds as the manifest declares them', () => {
    const port = manifest.user_config.oauth_callback_port;
    expect(port).toMatchObject({ default: 8976, min: 1024, max: 65535 });
    expect(installPage).toContain(String(port.default));
    expect(installPage).toContain(`${port.min} bis ${port.max}`);
  });

  it('couples the redirect URI to the port instead of hard-coding one', () => {
    expect(installPage).toContain('http://localhost:&lt;Port&gt;/callback');
    expect(runbookPage).toContain('http://localhost:&lt;Port&gt;/callback');
  });
});

describe('the colleague page speaks to someone without developer tooling', () => {
  // Every one of these appears in README.md, which is the source the page was written from. None of
  // them may reach this reader: the whole point of the .mcpb path is that it needs no terminal, no
  // clone and no Node toolchain, and a single stray `npm run …` sends a colleague to ask for help.
  const FORBIDDEN: [string, RegExp][] = [
    ['npm', /\bnpm\b/i],
    ['git clone', /\bgit\s+clone\b/i],
    ['node', /\bnode(\.js)?\b/i],
    ['Terminal', /\bterminals?\b/i],
    ['export ', /\bexport\s+[A-Z_]{3,}/],
    ['/plugin marketplace', /\/plugin\s+marketplace\b/i],
  ];

  for (const [label, re] of FORBIDDEN) {
    it(`does not mention ${label}`, () => {
      const hit = installPage.match(re);
      expect(hit ? `${label} → "${hit[0]}"` : null).toBeNull();
    });
  }

  // The owner's path has no archive in it. Stated as a positive: the page must SAY there is nothing
  // to unpack, which is what stops a colleague hunting for an unzip step that does not exist. A
  // ban on the word would forbid exactly that sentence.
  it('tells the reader outright that there is no archive and nothing to unpack', () => {
    expect(installPage).toMatch(/kein Archiv und\s+nichts zu entpacken/);
  });
});

describe('neither page carries a secret or an internal address', () => {
  // Same discipline as scripts/audit-bundle.mjs on the bundle, and for the same reason: these files
  // go on a download page. A finding names the PATH and the RULE and never the matched value.
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
    // A real tenant name is a disclosure in itself. Only the documented placeholder is allowed.
    // The lookbehind, not \b, is what makes this bite: with \b the placeholder `ihre-subdomain`
    // still matches from the `s`, and a real tenant name ending in `-support` would slip through
    // the same seam.
    { rule: 'zendesk-subdomain', re: /(?<![a-z0-9-])(?!ihre-subdomain\.)[a-z0-9][a-z0-9-]*\.zendesk\.com\b/i },
    // An address from the internal network. 127.x is not carved out: the pages say `localhost`.
    { rule: 'ip-address', re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  ];

  for (const page of PAGES) {
    const text = read(page);
    for (const { rule, re } of CREDENTIAL_PATTERNS) {
      it(`${page} is clean of ${rule}`, () => {
        expect(re.test(text) ? `${page} [${rule}]` : null).toBeNull();
      });
    }
  }
});

describe('both pages render offline, with nothing fetched from anywhere', () => {
  // A page on a download server that pulls a font or a script is a page that leaks who read it, and
  // one that renders wrong for the colleague sitting on a train. Attribute positions only — the
  // literal `http://localhost:<Port>/callback` in the prose is text the reader types, not a fetch.
  const EXTERNAL: { rule: string; re: RegExp }[] = [
    { rule: 'script-src', re: /<script[^>]*\ssrc\s*=/i },
    { rule: 'stylesheet-link', re: /<link[^>]*\srel\s*=\s*["']?stylesheet/i },
    { rule: 'css-import', re: /@import\b/i },
    { rule: 'css-url', re: /url\(\s*["']?(?!data:)[^)]/i },
    { rule: 'remote-attribute', re: /\b(?:src|href|action|poster|srcset|data|formaction)\s*=\s*["'](?:https?:)?\/\//i },
    { rule: 'iframe-or-embed', re: /<(?:iframe|embed|object|video|audio|img)\b/i },
  ];

  for (const page of PAGES) {
    const text = read(page);
    for (const { rule, re } of EXTERNAL) {
      it(`${page} pulls no external resource (${rule})`, () => {
        expect(re.test(text) ? `${page} [${rule}]` : null).toBeNull();
      });
    }
    it(`${page} is a complete standalone document`, () => {
      expect(text.trimStart().startsWith('<!doctype html>')).toBe(true);
      expect(text).toContain('</html>');
    });
  }
});

describe('the pages name the artifact the release actually produces', () => {
  // scripts/audit-bundle.mjs emits `zendesk-<version>.mcpb` plus a `.sha256` sidecar, and refuses to
  // emit anything when manifest.json and package.json disagree. A page naming a different file, or
  // last release's version, sends the colleague to a download that is not there.
  const version: string = manifest.version;
  const artifact = `zendesk-${version}.mcpb`;

  it('manifest.json and package.json agree on the version', () => {
    expect(JSON.parse(read('package.json')).version).toBe(version);
  });

  for (const page of PAGES) {
    it(`${page} names ${artifact} and the version`, () => {
      expect(read(page)).toContain(artifact);
      expect(read(page)).toContain(version);
    });
  }

  it('the runbook names the checksum sidecar', () => {
    expect(runbookPage).toContain(`${artifact}.sha256`);
  });
});

describe('the published checksum', () => {
  // Today there is no published release, so the page carries a placeholder the release step
  // replaces. Once it is replaced by a digest, that digest is held to the artifact — a page stating
  // a checksum nobody ever compared is worse than one stating none.
  const PLACEHOLDER = 'SHA256-PLATZHALTER-WIRD-BEIM-RELEASE-EINGESETZT';
  const digest = installPage.match(/\b[0-9a-f]{64}\b/);

  it('is either the placeholder or a SHA-256 digest, never both and never absent', () => {
    expect(installPage.includes(PLACEHOLDER) !== Boolean(digest)).toBe(true);
  });

  it('says how it is compared and that comparing is optional', () => {
    expect(installPage).toMatch(/freiwillig/i);
    expect(installPage).toContain('SHA-256');
    // Whom to ask when it differs — "contact support" is not an instruction.
    expect(installPage).toMatch(/Prüfsumme stimmt nicht überein/);
  });

  it('matches the artifact when the artifact is present and the digest is filled in', () => {
    const artifact = join(root, `zendesk-${manifest.version}.mcpb`);
    if (!digest || !existsSync(artifact)) return; // no release built here — nothing to contradict
    expect(createHash('sha256').update(readFileSync(artifact)).digest('hex')).toBe(digest[0]);
  });
});

describe('the pages keep the promises the issue holds them to', () => {
  it('the colleague page states that the bundle carries no PersoQua data', () => {
    expect(installPage).toContain('keine PersoQua-Daten');
  });

  it('the colleague page states that it does nothing without the three required values', () => {
    expect(installPage).toMatch(/Subdomain, Client-ID und Client-Secret nicht\s+eingetragen/);
  });

  it('the colleague page says where the two secret values come from', () => {
    expect(installPage).toMatch(/von deinem Administrator/i);
  });

  it('the colleague page covers a refused bundle and a login that does not complete', () => {
    expect(installPage).toContain('nimmt die Datei nicht an');
    expect(installPage).toContain('fünf Minuten sind abgelaufen');
  });

  it('the colleague page covers uninstalling, including what it leaves behind', () => {
    expect(installPage).toContain('id="deinstallation"');
    expect(installPage).toContain('Library/Application Support/zendesk-plugin');
  });

  it('the colleague page is honest about the slash commands', () => {
    expect(installPage).toMatch(/Claude Code/);
  });

  it('the runbook states the shared-secret consequence without softening it', () => {
    expect(runbookPage).toContain(
      'Ein geteiltes Secret ist für eine einzelne Person nicht widerrufbar.',
    );
    expect(runbookPage).toMatch(/trifft der einzige mögliche Schritt —\s+das Secret zu wechseln — alle Kollegen gleichzeitig/);
  });

  it('the runbook rules the download page out as a channel for the secret', () => {
    expect(runbookPage).toMatch(/Nicht<\/strong> über die Downloadseite/);
  });

  it('the runbook gives rotation as steps and says what colleagues do afterwards', () => {
    expect(runbookPage).toContain('id="rotation"');
    expect(runbookPage).toContain('Das müssen die Kollegen danach tun');
    expect(runbookPage).toContain('force: true');
  });

  it('the two audiences are two files', () => {
    expect(existsSync(join(root, INSTALL))).toBe(true);
    expect(existsSync(join(root, RUNBOOK))).toBe(true);
    // The colleague page must not drag the admin's operational detail in front of the colleague.
    expect(installPage).not.toContain('Admin Center');
  });
});
