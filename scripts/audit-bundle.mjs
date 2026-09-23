// scripts/audit-bundle.mjs
// Release gate for the packed Desktop Extension. `.mcpbignore` is an INTENTION: `mcpb pack` does
// not read .gitignore, so that one file is all that keeps tokens.enc, .zendesk-plugin-data/ and
// coverage/ out of a shipped, UNSIGNED bundle (see its header). This script is the PROOF, taken
// from the artifact itself rather than from the list that was supposed to produce it.
//
// Three properties, in this order:
//   1. Default-deny allowlist — every archive entry must match a declared rule. An allowlist read
//      the other way round (deny-list only) catches just what its author thought of.
//   2. Named forbidden paths at any depth — belt to the allowlist's braces, and a better message.
//   3. Credential scan of the text entries outside node_modules. The output names the PATH and the
//      RULE and never the matched value; an audit log that quotes the secret has moved it, not
//      found it (same discipline as tests/plugin/secret-safe-logging.test.ts).
//
// Only on a pass does it emit the versioned artifact and its SHA-256 sidecar, so "no artifact is
// published" when the audit fails is a property of the code and not of the operator's memory.
//
// Zero deps — plain Node, including the ZIP reader (a .mcpb is a ZIP). It is excluded from the
// bundle by .mcpbignore's `scripts/` line.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// --------------------------------------------------------------------------------------------
// The rules. Each one carries the name it is reported under, because "the audit failed" is not
// actionable and because the tests ablate them one at a time.
// --------------------------------------------------------------------------------------------

// Default-deny. An entry that matches nothing here is refused, whatever it looks like. Measured
// against the real bundle: 1930 entries, and above node_modules/ and dist/ exactly four files.
const ALLOWED = [
  { rule: 'manifest', match: (p) => p === 'manifest.json' },
  { rule: 'package-metadata', match: (p) => p === 'package.json' },
  { rule: 'license', match: (p) => p === 'LICENSE' },
  { rule: 'readme', match: (p) => p === 'README.md' },
  // The extension runs dist/server.js. Declaration maps and .d.ts are dropped by the packer, so
  // anything in dist/ that is not JavaScript is unexpected and gets refused.
  { rule: 'compiled-server', match: (p) => p.startsWith('dist/') && p.endsWith('.js') },
  // The bundle is self-contained; the four frozen runtime dependencies ship inside it. Keeping the
  // dev toolchain out is scripts/assert-prod-tree.mjs's job, not this one.
  { rule: 'runtime-dependencies', match: (p) => p.startsWith('node_modules/') },
];

// Named and checked independently of the allowlist, on EVERY path segment, so depth cannot hide
// them and so a future widening of the allowlist cannot quietly re-admit them. `kind: 'dir'` means
// the segment must have something under it; `kind: 'name'` matches the segment anywhere.
const FORBIDDEN = [
  { rule: 'encrypted-token-store', kind: 'name', match: (s) => s === 'tokens.enc' || s.endsWith('.enc') },
  { rule: 'dotenv-file', kind: 'name', match: (s) => s.startsWith('.env') },
  {
    rule: 'private-key-material',
    kind: 'name',
    match: (s) => s.endsWith('.pem') || s.endsWith('.key') || s.startsWith('id_rsa') || s.startsWith('id_ed25519'),
  },
  { rule: 'npm-credentials-file', kind: 'name', match: (s) => s === '.npmrc' },
  { rule: 'runtime-data-directory', kind: 'dir', match: (s) => s === '.zendesk-plugin-data' },
  { rule: 'user-data-directory', kind: 'dir', match: (s) => s === 'users' },
  { rule: 'issued-credential-directory', kind: 'dir', match: (s) => s === 'issued' },
  { rule: 'git-directory', kind: 'dir', match: (s) => s === '.git' },
  { rule: 'coverage-output', kind: 'dir', match: (s) => s === 'coverage' },
];

// Content rules. Two carve-outs in `credential-assignment`, both measured against the real bundle,
// both narrowing the VALUE and neither touching the other six rules or the default-deny allowlist:
//   - `$ { }` are excluded, so the MCPB user-config placeholders in manifest.json
//     (`"${user_config.oauth_client_secret}"`) are not reported — they are the template, not the
//     secret. Cost: a credential containing a brace slips this rule.
//   - a value of lowercase letters with `_`/`-` and NO digit is skipped, because that is an
//     identifier, not credential material: dist/auth/config.js:25 maps
//     `ZENDESK_OAUTH_CLIENT_SECRET: 'oauth_client_secret'`. Cost: an all-lowercase-letter secret
//     slips this rule. A digit, an uppercase letter or any other character is enough to be caught,
//     which covers Zendesk API tokens, OAuth client secrets and anything base64 or hex.
// Both costs are paid knowingly. A standing false positive is how a guard gets switched off.
const CREDENTIAL_PATTERNS = [
  { rule: 'private-key-block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { rule: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'json-web-token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { rule: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  {
    rule: 'credential-assignment',
    re: /(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|passwd|secret|token)["']?\s*[:=]\s*["']([^"'\s${}]{12,})["']/i,
    // Group 1 is the value. The test is deliberately NOT part of the /i regex above: under /i,
    // `[a-z]` also matches uppercase, and the carve-out would then swallow real mixed-case secrets.
    skip: (hit) => /^[a-z][a-z_-]*$/.test(hit[1]),
  },
  { rule: 'basic-auth-url', re: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/ },
  // Zendesk's own basic-auth shape: `user@example.com/token:<api token>`.
  { rule: 'zendesk-api-token-pair', re: /\/token:[A-Za-z0-9]{20,}/ },
];

// --------------------------------------------------------------------------------------------
// A .mcpb is a ZIP. Reading one without a dependency is ~50 lines; adding a dependency to audit an
// artifact for supply-chain material would be its own joke.
// --------------------------------------------------------------------------------------------
const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function readCentralDirectory(buf) {
  if (buf.length < 22) throw new Error('file is smaller than an empty ZIP archive');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no ZIP end-of-central-directory record — this is not a .mcpb archive');
  const count = buf.readUInt16LE(eocd + 10);
  const start = buf.readUInt32LE(eocd + 16);
  // Refuse rather than misread: the ZIP64 sentinels would otherwise be parsed as a real count.
  if (count === 0xffff || start === 0xffffffff) throw new Error('ZIP64 archive — this auditor reads 32-bit ZIP only');
  const entries = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_SIG) {
      throw new Error(`central directory entry ${i + 1} of ${count} is malformed`);
    }
    const nameLength = buf.readUInt16LE(at + 28);
    entries.push({
      name: buf.toString('utf8', at + 46, at + 46 + nameLength),
      method: buf.readUInt16LE(at + 10),
      compressedSize: buf.readUInt32LE(at + 20),
      size: buf.readUInt32LE(at + 24),
      local: buf.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return entries;
}

// The local header's extra field may differ in length from the central one's, so it is read here
// rather than reused — getting that wrong shifts the data window and inflate fails on valid input.
function readEntry(buf, entry) {
  if (entry.local + 30 > buf.length || buf.readUInt32LE(entry.local) !== LOCAL_SIG) {
    throw new Error(`${entry.name}: local file header is malformed`);
  }
  const at = entry.local + 30 + buf.readUInt16LE(entry.local + 26) + buf.readUInt16LE(entry.local + 28);
  const raw = buf.subarray(at, at + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`${entry.name}: unsupported ZIP compression method ${entry.method}`);
}

// --------------------------------------------------------------------------------------------

function forbiddenBy(path) {
  const segments = path.split('/');
  for (const rule of FORBIDDEN) {
    for (const [i, segment] of segments.entries()) {
      if (!rule.match(segment)) continue;
      if (rule.kind === 'dir' && i === segments.length - 1) continue;
      return rule.rule;
    }
  }
  return null;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function readJson(path, label, problems) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    problems.push(`${label} is missing or unreadable — the release version cannot be established`);
    return null;
  }
}

// --------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const positional = [];
let expectedVersion = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--expect-version') expectedVersion = argv[++i] ?? '';
  else positional.push(argv[i]);
}

const bundlePath = resolve(root, positional[0] ?? 'zendesk.mcpb');
const problems = [];
const accepted = [];

const pkg = readJson(join(root, 'package.json'), 'package.json', problems);
const manifest = readJson(join(root, 'manifest.json'), 'manifest.json', problems);
const version = manifest?.version ?? pkg?.version ?? null;

// A stale artifact from an earlier, passing run must not survive a failing one — otherwise "no
// artifact is published" holds only for the operator who never released this bundle before.
const artifactPath = version ? join(dirname(bundlePath), `${basename(bundlePath, '.mcpb')}-${version}.mcpb`) : null;
const checksumPath = artifactPath ? `${artifactPath}.sha256` : null;
if (artifactPath) for (const stale of [artifactPath, checksumPath]) rmSync(stale, { force: true });

if (pkg && manifest && pkg.version !== manifest.version) {
  problems.push(`version mismatch: manifest.json says ${manifest.version}, package.json says ${pkg.version}`);
}
if (expectedVersion !== null && version !== expectedVersion) {
  problems.push(`version mismatch: the release was asked for ${expectedVersion || '(empty)'}, the tree declares ${version}`);
}

let bundle = null;
let entries = [];
try {
  bundle = readFileSync(bundlePath);
  entries = readCentralDirectory(bundle);
} catch (error) {
  problems.push(`${basename(bundlePath)} could not be read as a bundle: ${error.message}`);
}

// An empty archive passes every path rule there is. That is a vacuous pass, not a clean bundle.
if (bundle && entries.length === 0) problems.push(`${basename(bundlePath)} contains no entries — an empty archive is not a release`);

for (const entry of entries) {
  const path = entry.name.split('\\').join('/');
  if (path.endsWith('/')) continue; // directory marker, carries no content

  const forbidden = forbiddenBy(path);
  if (forbidden) problems.push(`forbidden path in bundle: ${path} [${forbidden}]`);

  const allow = ALLOWED.find((rule) => rule.match(path));
  if (!allow) problems.push(`path matches no allowlist rule, refused by default: ${path}`);
  else if (!forbidden) accepted.push(`${path} [${allow.rule}]`);

  if (path.startsWith('node_modules/')) continue;

  let content;
  try {
    content = readEntry(bundle, entry);
  } catch (error) {
    problems.push(`entry could not be read: ${path} — ${error.message}`);
    continue;
  }
  if (content.subarray(0, 8192).includes(0)) continue; // binary, not a text entry
  const text = content.toString('utf8');
  for (const { rule, re, skip } of CREDENTIAL_PATTERNS) {
    // Every match is walked, not just the first: a carve-out that consumed the first hit would
    // otherwise hide a real secret further down the same file.
    const scan = new RegExp(re.source, `${re.flags}g`);
    for (let hit = scan.exec(text); hit !== null; hit = scan.exec(text)) {
      if (skip?.(hit)) continue;
      // Path and rule only. The matched value is never printed, here or anywhere downstream.
      problems.push(`credential material in bundle: ${path}:${lineOf(text, hit.index)} [${rule}]`);
      break; // one finding per rule per file — the point is the file, not the count
    }
  }
}

// The bundled manifest is what the host will read, so the version claim is checked against the
// artifact and not only against the tree that was supposed to produce it.
const bundledManifest = entries.find((e) => e.name === 'manifest.json');
if (bundle && entries.length > 0 && !bundledManifest) {
  problems.push('the bundle carries no manifest.json — the host has nothing to install');
} else if (bundle && bundledManifest) {
  try {
    const bundledVersion = JSON.parse(readEntry(bundle, bundledManifest).toString('utf8')).version;
    if (bundledVersion !== version) {
      problems.push(`version mismatch: the bundled manifest.json says ${bundledVersion}, the tree declares ${version}`);
    }
  } catch (error) {
    problems.push(`the bundled manifest.json could not be read: ${error.message}`);
  }
}

if (problems.length > 0) {
  console.error(`Refusing to release ${basename(bundlePath)}: the bundle did not pass the audit.`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nNo artifact and no checksum were produced. Fix the bundle (usually .mcpbignore) and pack again.');
  process.exit(1);
}

const sha256 = createHash('sha256').update(bundle).digest('hex');
writeFileSync(artifactPath, bundle);
// `shasum -a 256 -c <file>.sha256` format: digest, two spaces, the name it applies to.
writeFileSync(checksumPath, `${sha256}  ${basename(artifactPath)}\n`);

console.log(`Accepted ${accepted.length} paths:`);
for (const line of accepted) console.log(`  ${line}`);
console.log(`\nBundle audit passed: ${basename(bundlePath)}`);
console.log(`  version   ${version} (manifest.json, package.json and the bundled manifest agree)`);
console.log(`  entries   ${accepted.length} accepted, 0 refused`);
console.log(`  sha256    ${sha256}`);
console.log(`  artifact  ${basename(artifactPath)}`);
console.log(`  checksum  ${basename(checksumPath)}`);
console.log(`\nVerify the download with:\n  shasum -a 256 -c ${basename(checksumPath)}`);
