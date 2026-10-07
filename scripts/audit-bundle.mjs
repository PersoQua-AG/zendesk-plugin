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
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
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

function readJson(path, label, faults) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    faults.push(`${label} is missing or unreadable — the release version cannot be established`);
    return null;
  }
}

// --------------------------------------------------------------------------------------------
// TWO VERDICTS, TWO LISTS (#105). "This BUNDLE is unfit" and "this TREE cannot publish anything"
// used to share one list, and that list is what moves files: an unreadable manifest.json, an
// unreadable package.json, a bundle path that could not be read or a malformed --expect-version
// each renamed a provably clean bundle to .REJECTED and announced it as CONTAMINATED, naming
// .mcpbignore as the likely cause. Measured against a byte-identical bundle: readable manifests
// gave exit 0 and an artifact, both manifests corrupt made the same bundle disappear.
//
// `problems` is now only ever about the archive. `treeFaults` is about this checkout, and nothing
// in it moves anything.
// --------------------------------------------------------------------------------------------

// A path's name, with THREE answers rather than two (#105 AC9). 'unknown' is the one that was
// missing: an lstat that throws EACCES used to collapse into "taken", which is what made the
// quarantine fire on a path nobody had looked at. It collapses into neither side now.
function nameState(path) {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) === undefined ? 'free' : 'taken';
  } catch {
    // Not ENOENT — `throwIfNoEntry: false` already answered that. EACCES, ELOOP and the like mean
    // this script cannot tell, and by owner decision (#105) cannot-tell is reported, not acted on.
    return 'unknown';
  }
}

// How many .REJECTED slots the search may try. BOUNDED, and the bound is named rather than
// discovered: round 4 of PR #102's review measured an unbounded free-name search emit 67 MB of
// stderr and 90,235 lines in under 20 seconds, with the contaminated bundle never quarantined and
// the process only stopped by the reviewer's timeout. In CI that hangs the job. A hundred failed
// runs with their evidence still on disk is an operator problem, not a loop condition.
const QUARANTINE_SLOTS = 100;

// The first free quarantine name, or the reason there is none. BOTH names of a slot are checked,
// always: the symlink case below needs `<slot>.target` as well, and taking that unconditionally is
// cheaper than a parameter one call site passes conditionally and no test distinguishes. A
// non-symlink run never writes `.target`, so the only cost is stepping over a slot an earlier
// symlink run left evidence in — which is the behaviour this function exists for anyway.
function freeQuarantineSlot(base) {
  for (let n = 0; n <= QUARANTINE_SLOTS; n += 1) {
    const candidate = n === 0 ? `${base}.REJECTED` : `${base}.REJECTED.${n}`;
    const states = [candidate, `${candidate}.target`].map(nameState);
    if (states.includes('unknown')) return { fault: `cannot tell whether ${basename(candidate)} is already there` };
    if (states.every((state) => state === 'free')) return { name: candidate };
  }
  return { fault: `all ${QUARANTINE_SLOTS + 1} quarantine names next to ${basename(base)} are taken` };
}

// For the WORDING only. Whether the path is acceptable is decided by `isFile()` below, positively:
// deciding it by "none of these five matched" would let an st_mode this list does not know pass as
// a regular file, which is fail-open in a release gate. These are the five that have a name worth
// printing; anything else gets the generic sentence.
const SHAPES = [
  ['a directory', (s) => s.isDirectory()],
  ['a FIFO', (s) => s.isFIFO()],
  ['a socket', (s) => s.isSocket()],
  ['a block device', (s) => s.isBlockDevice()],
  ['a character device', (s) => s.isCharacterDevice()],
];

// WHAT IS UNDER THE PUBLISHABLE NAME, settled before anything reads it (#105 AC4, AC6).
// `readFileSync` on a FIFO blocks in open(2) for as long as nobody writes, and this path has no
// timeout: measured, the release gate produced no output at all and had to be killed after 6 s.
// A directory was worse than a hang — `renameSync` moved the WHOLE DIRECTORY to .REJECTED and
// called it contaminated. lstat and stat answer both questions without opening anything, so the
// refusal is bounded by construction rather than by a timer.
function bundleShape(path) {
  let link;
  try {
    link = lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    return { fault: `${basename(path)} cannot be examined: ${error.code ?? error.message}` };
  }
  if (link === undefined) return { fault: `there is nothing at ${path}` };
  const named = (stat) => SHAPES.find(([, is]) => is(stat))?.[0] ?? 'not a regular file';
  if (!link.isSymbolicLink()) {
    return link.isFile() ? {} : { fault: `${basename(path)} is ${named(link)}, not a packed bundle` };
  }
  let target;
  try {
    target = statSync(path, { throwIfNoEntry: false });
  } catch (error) {
    return { fault: `${basename(path)} is a symlink this script cannot follow: ${error.code ?? error.message}` };
  }
  if (target === undefined) return { fault: `${basename(path)} is a symlink pointing at nothing` };
  return target.isFile()
    ? { symlink: true }
    : { fault: `${basename(path)} is a symlink to ${named(target)}, not a packed bundle` };
}

// --------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const positional = [];
let expectedVersion = null;
for (let i = 0; i < argv.length; i++) {
  // Both spellings. `--expect-version=1.2.3` used to fall through to `positional` and become the
  // bundle path, so the run refused `there is nothing at …/--expect-version=1.2.3` and never
  // checked the version at all.
  if (argv[i] === '--expect-version') expectedVersion = argv[++i] ?? '';
  else if (argv[i].startsWith('--expect-version=')) expectedVersion = argv[i].slice('--expect-version='.length);
  else positional.push(argv[i]);
}
// EXACTLY ONE, not "at least one". A second positional was dropped without a word, so
// `audit-bundle.mjs a.mcpb b.mcpb` audited one of two named files and said nothing about the
// other — the same rule scripts/assert-no-bound-port-literals.mjs:82 draws for its scan root.
if (positional.length > 1) {
  console.error(
    `Expected at most one bundle path, got ${positional.length}: ${positional.join(', ')}.` +
      ' Audit them one at a time.',
  );
  process.exit(2);
}

// A RELATIVE ARGUMENT IS THE CALLER'S (#105 AC5). `resolve(root, …)` resolved it against the
// SCRIPT's tree, so from any other directory `node scripts/audit-bundle.mjs ./x.mcpb` silently
// meant `<repo>/x.mcpb` — a file the caller never named, audited and, on a failure, quarantined.
// An absolute argument is unaffected, and the default is still this repository's own bundle,
// which is what package.json's `pack` script relies on.
const bundlePath = positional[0] === undefined ? join(root, 'zendesk.mcpb') : resolve(positional[0]);
const problems = [];
// How many of `problems` are about the archive's VERSION rather than its CONTENT. "CONTAMINATED …
// Fix the cause (usually .mcpbignore)" is true of a forbidden path, a credential or an entry that
// cannot be read; it is false of a bundle that is simply not the release this tree now describes —
// nothing is in it that should not be, it is the wrong build. Counted rather than inferred from
// the strings, so the wording below cannot drift from what was actually found.
let versionProblems = 0;
const treeFaults = [];
const accepted = [];
// Counted for the coverage line the run prints, so the disclosure cannot go stale.
let scannedEntries = 0;
let scannedBytes = 0;

const pkg = readJson(join(root, 'package.json'), 'package.json', treeFaults);
const manifest = readJson(join(root, 'manifest.json'), 'manifest.json', treeFaults);
// A VERSION THAT CAN BE A FILE NAME, or no version at all. Two measured holes closed here:
//
// 1. `readJson` only faults when JSON.parse throws, so a manifest that PARSES but carries no
//    `version` left `version === null` — and then `artifactPath` was null and the success path ran
//    `writeFileSync(null, bundle)`, which is ERR_INVALID_ARG_TYPE as a stack trace under exit 1,
//    the script's own code for "this bundle did not pass". A bundle that passed every rule.
// 2. The string is interpolated into a path. A version of `../../../../VICTIM` escaped `root`, and
//    `rmSync` then deleted files four levels above it while the run announced the clean bundle as
//    contaminated. Semver characters only, no separator, no dot-segment.
const declaredVersion = manifest?.version ?? pkg?.version ?? null;
const version =
  typeof declaredVersion === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(declaredVersion) && !declaredVersion.includes('..')
    ? declaredVersion
    : null;
if (version === null && treeFaults.length === 0) {
  treeFaults.push(
    declaredVersion === null || declaredVersion === undefined
      ? 'neither manifest.json nor package.json declares a version — the release version cannot be established'
      : `the declared version ${JSON.stringify(String(declaredVersion))} cannot be a file name, so no` +
          ' artifact path can be built from it — the release version cannot be established',
  );
}

// A stale artifact from an earlier, passing run must not survive a failing one — otherwise "no
// artifact is published" holds only for the operator who never released this bundle before.
// THE ARTIFACT SLOT BELONGS TO THIS TREE, because `version` does (#105). It used to be
// `dirname(bundlePath)` — the CALLER's directory — while the number came from the script's
// manifest, so auditing a downloaded bundle cleared, and on a pass overwrote, the operator's own
// release of whatever version this checkout happens to declare, `.sha256` included, in a directory
// this script had never written to. Both the clearing below and the write on the success path now
// happen in `root`. For `npm run pack` nothing changes: there the bundle IS in root.
const artifactPath = version ? join(root, `${basename(bundlePath, '.mcpb')}-${version}.mcpb`) : null;
const checksumPath = artifactPath ? `${artifactPath}.sha256` : null;
// `force: true` suppresses ENOENT and nothing else. A stale artifact that is a non-empty
// directory makes this throw, and an unwritable parent makes it throw EACCES — unguarded, that
// throw landed before the verdict below and the run ended as a stack trace. A tree whose artifact
// slot cannot be cleared cannot be released from, whatever the bundle holds, so it is a TREE
// fault: nothing about the archive is being claimed and nothing is moved.
// NOT HERE. The clearing happens after the archive has been judged, so that a run which judged
// NOTHING deletes nothing — see clearStaleArtifact() at the verdict below. Measured before the
// move: `--expect-version` with a typo printed "Nothing was renamed and nothing was deleted" and
// had already deleted the operator's previously published artifact and its checksum.
function clearStaleArtifact() {
  if (!artifactPath) return;
  for (const stale of [artifactPath, checksumPath]) {
    try {
      // `force: true` suppresses ENOENT and nothing else. A stale artifact that is a non-empty
      // directory makes this throw, and an unwritable parent makes it throw EACCES — unguarded,
      // that throw ended the run as a stack trace. A tree whose artifact slot cannot be cleared
      // cannot be released from, whatever the bundle holds.
      rmSync(stale, { force: true });
    } catch (error) {
      treeFaults.push(
        `the stale artifact ${basename(stale)} could not be cleared: ${error.code ?? error.message}` +
          ' — this tree cannot be released from until that path is gone',
      );
    }
  }
}

// TWO version families since #68, by owner decision: manifest.json is the MCPB extension, which that
// issue does not change and which therefore stays at its own number, while package.json and the
// Claude Code plugin manifests moved on. So the equality that used to stand here cannot: what the
// bundle has to be right about is its OWN manifest, and that is asserted against manifest.json below
// (`the bundled manifest.json says …`). package.json's number is not shipped inside the bundle.
// A TREE fault, not a bundle one: the archive has not been looked at yet, and what disagrees is
// what the caller asked for against what this checkout declares.
if (expectedVersion !== null && version !== expectedVersion) {
  treeFaults.push(`version mismatch: the release was asked for ${expectedVersion || '(empty)'}, the tree declares ${version}`);
}

// THE SHAPE FIRST, THE READ SECOND, and the two faults are of different kinds.
const shape = bundleShape(bundlePath);
if (shape.fault) treeFaults.push(shape.fault);

let bundle = null;
let entries = [];
let readable = false;
if (!shape.fault) {
  try {
    bundle = readFileSync(bundlePath);
  } catch (error) {
    // A PATH THIS SCRIPT CANNOT READ IS UNKNOWN, NOT CONTAMINATED — owner decision on #105.
    // Quarantining it is what round 4 of PR #102's review measured destroying provably clean
    // bundles. So it is a tree fault: reported, named, left exactly where it is.
    treeFaults.push(
      `${basename(bundlePath)} could not be read: ${error.code ?? error.message}` +
        ' — unreadable is unknown, not contaminated, so nothing was moved',
    );
  }
}
// Everything from here down IS a verdict on the archive. The fail-closed reader family — an
// encrypted entry, a data descriptor, ZIP64, a record count that contradicts the records, a file
// present only in the local headers — belongs to `problems` and must keep quarantining, which is
// what #90 exists for.
if (bundle) {
  try {
    entries = readArchive(bundle);
    readable = true;
  } catch (error) {
    problems.push(`${basename(bundlePath)} could not be read as a bundle: ${error.message}`);
  }
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
  // A declared entry above node's string limit (~512 MB) threw ERR_STRING_TOO_LONG here as a
  // stack trace, which is an infrastructure failure standing where a release verdict belongs.
  // It is a refusal: the credential scan could not read the entry, and an entry the scan cannot
  // read is exactly what the NUL-byte rule above refuses too, for the same reason.
  let text;
  try {
    text = content.toString('utf8');
  } catch (error) {
    problems.push(
      `entry too large for the credential scan to read as text, refused: ${path}` +
        ` (${content.length} bytes, ${error.code ?? error.message})`,
    );
    continue;
  }
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
    // ONLY WHEN THE TREE HAS A VERSION TO COMPARE WITH. This is the exact route by which a broken
    // manifest.json destroyed a clean bundle: `version` fell to null, every bundle disagreed with
    // null, and the disagreement was filed as contamination. A comparison against an unknown is
    // not a finding about the archive; the unreadable manifest is already a tree fault above.
    if (version !== null && bundledVersion !== version) {
      problems.push(`version mismatch: the bundled manifest.json says ${bundledVersion}, the tree declares ${version}`);
      versionProblems += 1;
    }
  } catch (error) {
    problems.push(`the bundled manifest.json could not be read: ${error.message}`);
  }
}

// NOW the stale artifact goes, and only if the TREE is sound. "No artifact is published when the
// audit fails" is a promise about a release this tree could make; a tree that cannot publish is
// not making one, and deleting the operator's last release because their `--expect-version` had a
// typo is precisely what #105 exists to stop. Measured before this moved: a typo'd
// `--expect-version` deleted `zendesk-9.9.9.mcpb` and its `.sha256` and then printed "Nothing was
// renamed and nothing was deleted".
//
// The cost, named: on a run with BOTH a tree fault and a bundle finding, a stale artifact from an
// earlier passing run survives. That run publishes nothing of its own, exits non-zero and says the
// tree cannot publish, so nothing is announced that is not true — and the alternative is destroying
// a release over a fault that is not the bundle's.
//
// `clearStaleArtifact()` can add a tree fault of its own, which is why `treeFaults` is read after
// this line and not before it.
if (treeFaults.length === 0) clearStaleArtifact();

// THE TREE VERDICT. It moves nothing by itself, and it says exactly what the run did — because the
// price of the owner's decision is that a path somebody could upload stays under its name, and a
// message that hid that would make the decision worse than the defect it replaced.
if (treeFaults.length > 0) {
  console.error(`Cannot release from this tree: ${basename(bundlePath)} was not judged on this.`);
  for (const fault of treeFaults) console.error(`  - ${fault}`);
  // THE SENTENCE DEPENDS ON WHAT THE RUN THEN DID. A tree fault moves nothing by itself, but the
  // archive can still have been judged on its own and quarantined below — and a message that
  // promised "nothing was renamed" while the next paragraph renames the file would be the same
  // comment-against-code defect this ticket is cleaning up.
  console.error(
    problems.length > 0
      ? '\nNone of that is a verdict on the bundle, and none of it is a .mcpbignore problem. The' +
          ' archive was judged on its own, below.'
      : `\nThis is NOT a verdict on the bundle, and it is not a .mcpbignore problem. Nothing was` +
          ` renamed and nothing was deleted: whatever is at ${bundlePath} is STILL THERE, under` +
          ` that name${shape.fault ? '' : ', and can still be uploaded under it'}. Fix the tree and` +
          ' run the audit again; until then the file is the operator\'s to deal with.',
  );
}

if (problems.length > 0) {
  if (treeFaults.length > 0) console.error('');
  console.error(`Refusing to release ${basename(bundlePath)}: the bundle did not pass the audit.`);
  for (const p of problems) console.error(`  - ${p}`);
  // Clearing only the versioned copy left the FILE package.json names sitting there with the
  // secret inside it — the one somebody would upload. It is renamed rather than deleted so the
  // evidence survives for whoever has to find out how it got in.
  // NO NAME CHECK HERE, and that is the design rather than an omission. PR #102 had to ask "is
  // there a name" because the condition was `bundle` — the BUFFER, which is null for every read
  // that threw, exactly the runs where the file is still under its publishable name. On this
  // branch a read that threw is a TREE fault and the file is deliberately left alone (owner
  // decision), and a shape that is not a regular file never got here either. Reaching this point
  // means bundleShape() said "a regular file" and readFileSync() returned its bytes.
  let quarantined = null;
  // THE PREVIOUS QUARANTINE SURVIVES. This used to `rmSync(quarantined, { force: true })` three
  // lines under a comment promising the evidence would survive; measured over two failing runs,
  // run 2 overwrote run 1's .REJECTED and the tokens.enc inside it was gone. A free slot is
  // searched for instead, and the search is bounded — see QUARANTINE_SLOTS.
  //
  // A SYMLINK NEEDS BOTH NAMES. `renameSync` on a link moves the LINK; the target keeps the name
  // it is reachable under, so "it cannot be uploaded by name" held for the link only. The target
  // moves first — realpath is read before anything moves — and the link after it, so neither
  // name resolves to an uploadable artifact.
  const slot = freeQuarantineSlot(bundlePath);
  if (slot.fault) {
    console.error(`  - could not quarantine ${basename(bundlePath)}: ${slot.fault} — DELETE IT BY HAND`);
  } else {
    try {
      if (shape.symlink) renameSync(realpathSync(bundlePath), `${slot.name}.target`);
      renameSync(bundlePath, slot.name);
      quarantined = slot.name;
    } catch (error) {
      console.error(`  - could not quarantine ${basename(bundlePath)}: ${error.message} — DELETE IT BY HAND`);
    }
  }
  console.error('\nNo artifact and no checksum were produced.');
  if (quarantined) {
    console.error(
      `${basename(bundlePath)} is ${problems.length > versionProblems ? 'CONTAMINATED' : 'NOT THE RELEASE THIS TREE DESCRIBES'}` +
        ` and has been moved to ${basename(quarantined)}` +
        `${shape.symlink ? ` (and what it pointed at to ${basename(quarantined)}.target)` : ''} so it` +
        ' cannot be uploaded by name. Do not publish it.' +
        (problems.length > versionProblems
          ? ' Fix the cause (usually .mcpbignore) and pack again.'
          : ' Nothing is in it that should not be — it is the wrong build. Pack it again from this tree.'),
    );
  }
}

// Exit 1 is "this bundle did not pass", exit 2 is "this tree could not judge it" — the
// distinction scripts/assert-no-bound-port-literals.mjs:140 draws between "looked and found" and
// "could not look". THE BUNDLE VERDICT WINS when there is one, and the earlier way round was
// wrong: a contaminated bundle plus a `--expect-version` typo exited 2 although the archive HAD
// been judged and quarantined in that very run, which contradicts #105 AC 2 ("the exit code for a
// contaminated bundle is unchanged") and contradicted the comment that stood here. Exit 2 is now
// exactly the case it names: no bundle verdict was reached.
if (problems.length > 0) process.exit(1);
if (treeFaults.length > 0) process.exit(2);

const sha256 = createHash('sha256').update(bundle).digest('hex');
writeFileSync(artifactPath, bundle);
// `shasum -a 256 -c <file>.sha256` format: digest, two spaces, the name it applies to.
writeFileSync(checksumPath, `${sha256}  ${basename(artifactPath)}\n`);

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
// NAMED FROM WHERE THE CALLER STANDS. The artifact slot is this tree's (see artifactPath), so for
// a bundle handed in from elsewhere a bare basename is a verify command that cannot work in the
// caller's directory — measured: the two files were in the repository and the operator was told to
// check them in their download folder.
const here = (p) => relative(process.cwd(), p) || basename(p);
console.log(`  artifact  ${here(artifactPath)}`);
console.log(`  checksum  ${here(checksumPath)}`);
console.log(`\nVerify the download with:\n  shasum -a 256 -c ${here(checksumPath)}`);
