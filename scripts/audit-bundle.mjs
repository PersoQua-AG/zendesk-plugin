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
import { lstatSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  // A directory marker is a zero-byte entry whose name ends in "/". `mcpb pack` emits none today
  // (measured: 0 of 1930), but an entry that is neither accepted nor refused is the one shape the
  // default-deny promise cannot cover, so markers are judged like everything else and allowed only
  // inside a tree that is itself allowed. First in the list so they are reported under this name.
  { rule: 'directory-marker', match: (p) => p.endsWith('/') && (p.startsWith('dist/') || p.startsWith('node_modules/')) },
  { rule: 'manifest', match: (p) => p === 'manifest.json' },
  { rule: 'package-metadata', match: (p) => p === 'package.json' },
  { rule: 'license', match: (p) => p === 'LICENSE' },
  { rule: 'readme', match: (p) => p === 'README.md' },
  // The extension runs dist/server.js. Declaration maps and .d.ts are dropped by the packer, so
  // anything in dist/ that is not JavaScript is unexpected and gets refused.
  { rule: 'compiled-server', match: (p) => p.startsWith('dist/') && p.endsWith('.js') },
  // The bundle is self-contained; the five frozen runtime dependencies ship inside it. Keeping the
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

// Content rules, and what they do NOT reach.
//
// SCOPE: the scan reads only what is not node_modules/**. Every passing run PRINTS the share it
// actually covered, with both denominators — a figure written into this comment was already stale
// one merge later (it said 72 of 1930 while the bundle had grown), and a number nobody can be
// relied on to re-measure eventually becomes a false statement. `node_modules/**` is out of scope
// deliberately: its content comes
// from `npm ci --omit=dev` against the lockfile, and a credential in there is a compromised
// package, which this audit is the wrong tool for. So the scan protects against OUR OWN material leaking
// into the bundle. It does not protect against a malicious dependency, and it never did.
//
// Known gaps in the rules themselves, each measured with exit 0 and kept knowingly rather than
// bought with a false positive that would get the guard switched off:
//   - an UNQUOTED assignment (`access_token=<token>`) — the rule requires quotes, because without
//     them `access_token = config.someIdentifier` in compiled JS matches just as well.
//   - a bare token literal with no keyword at all (`const t = "<40 chars>"`) — nothing marks it as
//     credential material, and an entropy rule over compiled JavaScript reports hashes and ids.
//   - an all-lowercase-letter value with no digit, which the identifier carve-out below skips.
// The default-deny allowlist, not these rules, is what keeps the bundle small enough that these
// gaps stay narrow.
const CREDENTIAL_PATTERNS = [
  { rule: 'private-key-block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { rule: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'json-web-token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { rule: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  {
    rule: 'credential-assignment',
    re: /(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|passwd|secret|token)["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i,
    // Group 1 is the value, and both carve-outs are on the VALUE, not in the /i regex above: under
    // /i a `[a-z]` class also matches uppercase and would swallow real mixed-case secrets.
    //   - `${...}` ONLY when the value is nothing but the placeholder. manifest.json holds
    //     `"${user_config.oauth_client_secret}"`, which is the template and not the secret.
    //     Excluding braces from the value class instead (the first version here) let through every
    //     secret that happens to contain one — strictly worse for the same length.
    //   - a lowercase identifier with no digit: dist/auth/config.js:25 maps
    //     `ZENDESK_OAUTH_CLIENT_SECRET` to the field name `'oauth_client_secret'`.
    skip: (hit) => /^\$\{[^}]*\}$/.test(hit[1]) || /^[a-z][a-z_-]*$/.test(hit[1]),
  },
  { rule: 'basic-auth-url', re: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/ },
  // Zendesk's own basic-auth shape: `user@example.com/token:<api token>`.
  { rule: 'zendesk-api-token-pair', re: /\/token:[A-Za-z0-9]{20,}/ },
];

// --------------------------------------------------------------------------------------------
// A .mcpb is a ZIP. Reading one without a dependency is the job below; adding a dependency to audit
// an artifact for supply-chain material would be its own joke. A cheaper shell-out does not work
// either: `unzip -p <file> <name>` treats the entry name as a GLOB, so in an archive holding both
// `dist/a[1].js` (content SECRET_A) and `dist/a1.js` (content DECOY) it prints the DECOY and exits
// 0 — it loses findings silently, which is the one thing an auditor may not do.
//
// The whole reader is FAIL-CLOSED: anything it cannot read with certainty is a refusal, never a
// skip. The rule it has to meet is that it sees every entry a real unpacker sees — python3
// zipfile, unzip and the streaming bsdtar — or refuses the archive. Concretely that means:
//   - the central directory is parsed by its SIZE, not by the EOCD entry COUNT. A count that
//     understates the directory hides every record behind it; trusting it let a `secret.txt`
//     through with exit 0 while python3 zipfile listed it.
//   - a declared count that disagrees with the records found is a refusal, not a repair. An
//     archive that misreports itself does not get shipped.
//   - every local file header between byte 0 and the directory must be accounted for by a
//     directory record with the same name, so an entry that exists only in the local headers
//     (which bsdtar streams out) cannot hide.
//   - a data descriptor (general-purpose bit 3) is refused: its central-directory sizes may be 0,
//     and a zero size would make the credential scan read nothing and report nothing — silence
//     that looks exactly like a clean file.
//   - an encrypted entry (bit 0), a ZIP64 sentinel, an unknown compression method, and any entry
//     whose real byte count disagrees with its declaration are all refusals for the same reason.
// --------------------------------------------------------------------------------------------
const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const ZIP64_U16 = 0xffff;
const ZIP64_U32 = 0xffffffff;

function readArchive(buf) {
  if (buf.length < 22) throw new Error('file is smaller than an empty ZIP archive');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no ZIP end-of-central-directory record — this is not a .mcpb archive');

  // A multi-part archive: the records this file holds are not all of them, and the rest are in a
  // file this auditor was never handed. Refusing beats auditing one volume of several.
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    throw new Error('multi-part ZIP archive — this auditor reads single-file archives only');
  }
  if (buf.readUInt16LE(eocd + 8) !== buf.readUInt16LE(eocd + 10)) {
    throw new Error('the end-of-central-directory disagrees with itself about how many entries there are');
  }
  const declared = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdStart = buf.readUInt32LE(eocd + 16);
  if (declared === ZIP64_U16 || cdSize === ZIP64_U32 || cdStart === ZIP64_U32) {
    throw new Error('ZIP64 archive — this auditor reads 32-bit ZIP only');
  }
  const cdEnd = cdStart + cdSize;
  if (cdEnd > buf.length || cdEnd > eocd) throw new Error('the central directory runs past the end of the file');

  // Parsed by SIZE. The declared count is then a claim to be CHECKED, never the loop bound.
  const entries = [];
  let at = cdStart;
  while (at < cdEnd) {
    if (at + 46 > cdEnd || buf.readUInt32LE(at) !== CENTRAL_SIG) {
      throw new Error(`central directory record ${entries.length + 1} is malformed`);
    }
    const flags = buf.readUInt16LE(at + 8);
    const nameLength = buf.readUInt16LE(at + 28);
    const entry = {
      name: buf.toString('utf8', at + 46, at + 46 + nameLength),
      method: buf.readUInt16LE(at + 10),
      compressedSize: buf.readUInt32LE(at + 20),
      size: buf.readUInt32LE(at + 24),
      local: buf.readUInt32LE(at + 42),
    };
    if (flags & FLAG_ENCRYPTED) throw new Error(`${entry.name}: entry is encrypted and cannot be inspected`);
    if (flags & FLAG_DATA_DESCRIPTOR) {
      // Its directory sizes may be 0 while the real bytes sit after the data. Reading 0 bytes and
      // finding no credentials is silence, not a clean result.
      throw new Error(`${entry.name}: entry uses a data descriptor, so its declared size cannot be trusted`);
    }
    if (entry.compressedSize === ZIP64_U32 || entry.size === ZIP64_U32 || entry.local === ZIP64_U32) {
      throw new Error(`${entry.name}: ZIP64 sentinel in the central directory — this auditor reads 32-bit ZIP only`);
    }
    entries.push(entry);
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  if (at !== cdEnd) throw new Error('the central directory does not end on a record boundary');
  if (entries.length !== declared) {
    throw new Error(
      `the end-of-central-directory claims ${declared} entries, the directory holds ${entries.length}`,
    );
  }

  // Walk the local headers as a streaming unpacker does. Every one must be a directory record with
  // the same name, and they must tile the region before the directory with no gaps.
  const byOffset = new Map(entries.map((entry) => [entry.local, entry]));
  let pos = 0;
  let previous = null;
  while (pos < cdStart) {
    if (pos + 30 > cdStart || buf.readUInt32LE(pos) !== LOCAL_SIG) {
      // Naming the entry the walk came from is the whole diagnosis: the usual cause is that the
      // one before it declared a size its data does not have, and this check is what refuses it.
      throw new Error(
        `byte ${pos}: expected a local file header${previous ? ` after ${previous.name}` : ''}` +
          ', and a streaming unpacker would read something else',
      );
    }
    const entry = byOffset.get(pos);
    const nameLength = buf.readUInt16LE(pos + 26);
    const localName = buf.toString('utf8', pos + 30, pos + 30 + nameLength);
    if (!entry) throw new Error(`${localName}: present in the local headers but absent from the central directory`);
    if (localName !== entry.name) {
      throw new Error(`local header names ${localName} where the central directory names ${entry.name}`);
    }
    entry.dataAt = pos + 30 + nameLength + buf.readUInt16LE(pos + 28);
    pos = entry.dataAt + entry.compressedSize;
    previous = entry;
  }
  if (pos !== cdStart) throw new Error('the local headers do not reach the central directory');
  for (const entry of entries) {
    if (entry.dataAt === undefined) throw new Error(`${entry.name}: its local file header is unreachable`);
  }
  return entries;
}

// Relies on an invariant readArchive establishes: the local-header walk terminates only at
// pos === cdStart, and every entry's dataAt + compressedSize is one of the pos values along that
// chain, so each is <= cdStart <= eocd <= buf.length - 22. The data window is therefore always in
// bounds. There was a `raw.length !== entry.compressedSize` guard here; it could not be reached,
// no fixture could make it fire, and an untestable branch is where the next rewrite loses a rule
// without anyone noticing. If that walk is ever relaxed, this line comes back WITH a fixture.
function readEntry(buf, entry) {
  const raw = buf.subarray(entry.dataAt, entry.dataAt + entry.compressedSize);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`${entry.name}: unsupported ZIP compression method ${entry.method}`);
  }
  let content;
  if (entry.method === 0) {
    content = Buffer.from(raw);
  } else {
    // The cap turns a decompression bomb into a finding instead of an out-of-memory kill. It is
    // floored at 1 because Node rejects maxOutputLength 0 as an ARGUMENT error — and the real
    // bundle holds 15 legitimately empty DEFLATE entries (size 0, 2 compressed bytes), so 0 is a
    // value this sees in practice. zlib's own message is re-worded so the operator reads a rule.
    try {
      content = inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) });
    } catch (error) {
      throw new Error(`${entry.name}: expands past the ${entry.size} bytes it declares (${error.code ?? error.message})`);
    }
  }
  if (content.length !== entry.size) {
    throw new Error(`${entry.name}: holds ${content.length} bytes where the directory declares ${entry.size}`);
  }
  return content;
}

// A path a real unpacker would write outside the extraction root, or cannot represent at all.
function unsafePath(path) {
  if (path === '' || path === '/') return 'an empty entry name';
  if (path.startsWith('/')) return 'an absolute path';
  if (/^[A-Za-z]:/.test(path)) return 'a drive-letter path';
  // A control character is invisible in this script's own report: `dist/a\0b.js` printed as
  // `dist/a b.js`, so the inventory named a file that is not the file in the archive, and a
  // newline would let an entry name forge findings outright.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'a control character in the name';
  // One trailing slash is the directory-marker convention, not an empty segment. Stripping it here
  // is what lets a marker be JUDGED by the path rules instead of waved past them.
  const segments = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  if (segments.includes('..')) return 'a parent-directory segment';
  if (segments.some((segment) => segment === '' )) return 'an empty path segment';
  return null;
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
// Counted for the coverage line the run prints, so the disclosure cannot go stale.
let scannedEntries = 0;
let scannedBytes = 0;

const pkg = readJson(join(root, 'package.json'), 'package.json', problems);
const manifest = readJson(join(root, 'manifest.json'), 'manifest.json', problems);
const version = manifest?.version ?? pkg?.version ?? null;

// "Is there a name here", not "does it resolve". `existsSync` follows symlinks, so a dangling
// artifact link reads as absent while still sitting in the directory under its publishable name.
const present = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// A stale artifact from an earlier, passing run must not survive a failing one — otherwise "no
// artifact is published" holds only for the operator who never released this bundle before.
const artifactPath = version ? join(dirname(bundlePath), `${basename(bundlePath, '.mcpb')}-${version}.mcpb`) : null;
const checksumPath = artifactPath ? `${artifactPath}.sha256` : null;
// `force: true` suppresses ENOENT and nothing else. Measured on node v26.5.0, a stale artifact
// that is a non-empty directory — one a different user or a half-finished run can leave — makes
// this throw ERR_FS_EISDIR, and an unwritable parent makes it throw EACCES. Unguarded, that throw
// landed 112 lines above the quarantine below, so the failed bundle stayed under its publishable
// name: exactly the safeguard it skipped.
//
// It is a REFUSAL rather than a warning, and the measurement is why: the same directory makes the
// `writeFileSync(artifactPath, bundle)` on the success path throw EISDIR too, after the run has
// already printed that the audit passed. A tree whose artifact slot cannot be cleared is a tree
// this script cannot release from, whatever the bundle contains.
//
// A SEPARATE LIST FROM `problems`, and that separation is load-bearing. These two answer different
// questions — "is this bundle fit to publish" and "can this tree publish anything" — and while a
// housekeeping failure sat in `problems`, a bundle that passed every single rule was renamed to
// `.REJECTED` and announced as CONTAMINATED with "Fix the cause (usually .mcpbignore)". Every word
// of that was false for the tree it was said about, and the good bundle was destroyed to say it.
// The quarantine below now runs on `problems` alone; housekeeping decides only the exit code.
const housekeeping = [];

// A BUNDLE WHOSE VERSION CANNOT BE ESTABLISHED IS UNFIT, and saying so here is what keeps the rest
// of this block honest. With both manifest.json and package.json unreadable or versionless,
// `artifactPath` is null: the write below answered `writeFileSync(null, …)` with an uncaught
// ERR_INVALID_ARG_TYPE whose own catch then threw again on `basename(null)` — five frames and exit
// 1, a tree to fix reported as a bundle to fix, which is the #90 class reappearing inside the #90
// fix. `scripts/validate-manifests.mjs` rejects an empty version before `npm run pack` ever gets
// here, so only a direct invocation reaches it — which is what the tests do, and what auditing a
// downloaded artifact would do.
if (!version) {
  problems.push(
    'no version could be read from manifest.json or package.json — there is no name to publish this' +
      ' bundle under, so it cannot be released',
  );
}

// BY PATTERN, not by the one computed name. `if (artifactPath)` skipped the clearing entirely when
// the version was unresolvable, so an earlier passing run's `zendesk-<v>.mcpb` and its `.sha256`
// stayed on disk while the refusal printed "No artifact and no checksum were produced." Reproduced
// with both version sources unreadable. The invariant this block exists for does not depend on
// being able to name the version, so neither does the sweep. `zendesk.mcpb` itself carries no
// `-<version>` and is never matched; the quarantine below is what handles it.
const stale = new RegExp(`^${basename(bundlePath, '.mcpb').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-.+\\.mcpb(\\.sha256)?$`);
const artifactDir = dirname(bundlePath);
let staleNames = [];
try {
  staleNames = readdirSync(artifactDir).filter((name) => stale.test(name));
} catch (error) {
  housekeeping.push(
    `could not list ${artifactDir} to clear stale artifacts: ${error.message}` +
      ' — this tree cannot be released from until that directory is readable',
  );
}
for (const name of staleNames) {
  try {
    rmSync(join(artifactDir, name), { recursive: false, force: true });
  } catch (error) {
    housekeeping.push(
      `could not clear the stale artifact ${name}: ${error.message}` +
        ' — this tree cannot be released from until that path is gone',
    );
  }
}

// TWO version families since #68, by owner decision: manifest.json is the MCPB extension, which that
// issue does not change and which therefore stays at its own number, while package.json and the
// Claude Code plugin manifests moved on. So the equality that used to stand here cannot: what the
// bundle has to be right about is its OWN manifest, and that is asserted against manifest.json below
// (`the bundled manifest.json says …`). package.json's number is not shipped inside the bundle.
if (expectedVersion !== null && version !== expectedVersion) {
  problems.push(`version mismatch: the release was asked for ${expectedVersion || '(empty)'}, the tree declares ${version}`);
}

let bundle = null;
let entries = [];
let readable = false;
try {
  bundle = readFileSync(bundlePath);
  entries = readArchive(bundle);
  readable = true;
} catch (error) {
  problems.push(`${basename(bundlePath)} could not be read as a bundle: ${error.message}`);
}

// An empty archive passes every path rule there is. That is a vacuous pass, not a clean bundle.
// Guarded on `readable` so an archive that failed to parse is reported once, by its real cause,
// instead of also being announced as empty.
if (readable && entries.length === 0) problems.push(`${basename(bundlePath)} contains no entries — an empty archive is not a release`);

for (const entry of entries) {
  const path = entry.name.split('\\').join('/');
  const unsafe = unsafePath(path);
  if (unsafe) problems.push(`unsafe entry name, refused: ${JSON.stringify(path)} is ${unsafe}`);

  const forbidden = forbiddenBy(path);
  if (forbidden) problems.push(`forbidden path in bundle: ${path} [${forbidden}]`);

  const allow = unsafe ? null : ALLOWED.find((rule) => rule.match(path));
  if (!allow && !unsafe) {
    problems.push(
      `path matches no allowlist rule, refused by default: ${path}` +
        ' (exclude it in .mcpbignore, or declare it in the allowlist if it belongs in the bundle)',
    );
  }
  if (allow && !forbidden) accepted.push({ path, rule: allow.rule });

  // A directory marker carries no content to scan. It has been through unsafePath, the forbidden
  // list and the allowlist above, so it is accounted for in the counts either way; what it may not
  // be is a marker with a payload.
  if (path.endsWith('/')) {
    if (entry.size !== 0) problems.push(`directory marker carrying ${entry.size} bytes of content: ${path}`);
    continue;
  }

  if (path.startsWith('node_modules/')) continue;

  let content;
  try {
    content = readEntry(bundle, entry);
  } catch (error) {
    problems.push(`entry could not be read: ${path} — ${error.message}`);
    continue;
  }
  // Outside node_modules the bundle is compiled JavaScript, Markdown, JSON and a licence — all
  // text. A NUL byte there is either a binary smuggled past the allowlist on its extension
  // (dist/tokens.enc.js was the measured case) or a file the scan cannot read. Skipping it would
  // switch all seven credential rules off for that entry without saying so, so it is a refusal.
  if (content.subarray(0, 8192).includes(0)) {
    problems.push(`binary content where only text belongs, and the credential scan cannot read it: ${path}`);
    continue;
  }
  scannedEntries++;
  scannedBytes += content.length;
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

if (problems.length > 0 || housekeeping.length > 0) {
  console.error(
    problems.length > 0
      ? `Refusing to release ${basename(bundlePath)}: the bundle did not pass the audit.`
      : `Refusing to release ${basename(bundlePath)}: this tree cannot be released from.`,
  );
  for (const p of [...problems, ...housekeeping]) console.error(`  - ${p}`);
  // Clearing only the versioned copy left the FILE package.json names sitting there with the
  // secret inside it — the one somebody would upload. It is renamed rather than deleted so the
  // evidence survives for whoever has to find out how it got in.
  //
  // The condition is "the file is still lying there", not "we managed to read it". `bundle` is null
  // for every read that threw — EACCES, EISDIR, a mid-pack truncation — and on exactly those runs
  // the file is still sitting under its publishable name. Guarding on `bundle` skipped the
  // quarantine on the cases that need it most, which is the #90 defect one level down.
  //
  // `lstatSync`, not `existsSync`: `existsSync` follows the link, so a DANGLING `zendesk.mcpb`
  // symlink answered false and the publishable name survived without a word about it. The question
  // is whether a name is there for somebody to upload, not whether it resolves.
  let quarantined = null;
  if (problems.length > 0 && present(bundlePath)) {
    quarantined = `${bundlePath}.REJECTED`;
    try {
      rmSync(quarantined, { force: true });
      renameSync(bundlePath, quarantined);
    } catch (error) {
      quarantined = null;
      // A quarantine this script could not perform is housekeeping it could not do, so it exits 2
      // and not 1: the caller is being told to fix the TREE, by hand, before anything is uploaded.
      const said = `could not quarantine ${basename(bundlePath)}: ${error.message} — DELETE IT BY HAND`;
      // Printed here because the `[...problems, ...housekeeping]` loop above has already run; the
      // push is what carries the exit code, and one string so the two cannot drift.
      housekeeping.push(said);
      console.error(`  - ${said}`);
    }
  }
  console.error('\nNo artifact and no checksum were produced.');
  if (quarantined) {
    console.error(
      `${basename(bundlePath)} is CONTAMINATED and has been moved to ${basename(quarantined)} so it cannot be` +
        ' uploaded by name. Do not publish it. Fix the cause (usually .mcpbignore) and pack again.',
    );
  }
  // Exit 2 is "this script could not do its own housekeeping", kept apart from exit 1, "the bundle
  // did not pass", the way scripts/assert-no-bound-port-literals.mjs:140 separates the two. The
  // caller needs the distinction: exit 1 is a bundle to fix, exit 2 is a tree to fix.
  process.exit(housekeeping.length > 0 ? 2 : 1);
}

// WRAPPED, because clearing the slot succeeding does not mean writing into it will. Measured on
// node v26.5.0, a read-only parent lets `rmSync(stale, { force: true })` pass — the path is not
// there, so ENOENT is suppressed — and answers this write with EACCES. Unwrapped that was a node
// stack trace and exit 1: a tree to fix, reported as a bundle to fix, through the one path the
// no-stack-trace bar does not cover. It is exit 2 for the same reason the cleanup failure is.
const sha256 = createHash('sha256').update(bundle).digest('hex');
try {
  writeFileSync(artifactPath, bundle);
  // `shasum -a 256 -c <file>.sha256` format: digest, two spaces, the name it applies to.
  writeFileSync(checksumPath, `${sha256}  ${basename(artifactPath)}\n`);
} catch (error) {
  console.error(`Refusing to release ${basename(bundlePath)}: this tree cannot be released from.`);
  console.error(
    `  - the audit passed, but ${basename(artifactPath)} could not be written: ${error.message}` +
      ' — this tree cannot be released from until that path is writable',
  );
  // The bundle is CLEAN, so it is left exactly where it is. Nothing is quarantined and nothing is
  // called contaminated: the defect is the tree, and the packed bundle is the thing to keep.
  //
  // WRAPPED TOO. These two are housekeeping inside a housekeeping handler: a throw here — the half
  // of the pair that is a directory, say — would replace this exit 2 with a stack trace and exit 1,
  // which is the unguarded-housekeeping shape one level up. `recursive` is off deliberately: a
  // directory in the artifact slot is reported, not silently emptied.
  for (const half of [checksumPath, artifactPath]) {
    try {
      rmSync(half, { recursive: false, force: true });
    } catch (second) {
      console.error(`  - and ${basename(half)} could not be removed either: ${second.message} — REMOVE IT BY HAND`);
    }
  }
  process.exit(2);
}

const dependencies = accepted.filter((a) => a.rule === 'runtime-dependencies').length;
console.log(`Accepted ${accepted.length} paths, of which ${dependencies} are node_modules/** [runtime-dependencies].`);
console.log(`The other ${accepted.length - dependencies}, in full:`);
for (const { path, rule } of accepted) if (rule !== 'runtime-dependencies') console.log(`  ${path} [${rule}]`);
console.log(`\nBundle audit passed: ${basename(bundlePath)}`);
const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
const share = (part, whole) => (whole === 0 ? '0.0' : ((100 * part) / whole).toFixed(1));
console.log(`  version   ${version} (manifest.json and the bundled manifest agree; package.json carries the plugin version)`);
console.log(`  entries   ${accepted.length} accepted, 0 refused`);
console.log(
  `  scanned   ${scannedEntries} of ${entries.length} entries (${share(scannedEntries, entries.length)}%)` +
    `, ${scannedBytes.toLocaleString('en-US')} of ${totalBytes.toLocaleString('en-US')} bytes` +
    ` (${share(scannedBytes, totalBytes)}%) — node_modules/** is out of scope by decision`,
);
console.log(`  sha256    ${sha256}`);
console.log(`  artifact  ${basename(artifactPath)}`);
console.log(`  checksum  ${basename(checksumPath)}`);
console.log(`\nVerify the download with:\n  shasum -a 256 -c ${basename(checksumPath)}`);
