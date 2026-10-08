import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { constants } from 'node:buffer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUDIT = join(root, 'scripts', 'audit-bundle.mjs');

// Planted credential material. Every value here is a SENTINEL: no test may ever find it in the
// audit's own output, because an audit that quotes the secret has moved it, not found it.
const SENTINEL_TOKEN = 'aB3dEfGh1jKlMn0pQrStUvWxYz456789AbCdEfGh';
// One planted line, shared by every fixture that needs credential material. It is a constant
// rather than an ad-hoc string per test because three of these fixtures first used a key (`t`)
// that matches no rule at all: the tests were green, and green for the wrong reason.
const PLANTED = `access_token = "${SENTINEL_TOKEN}"\n`;
// The seven content rules with a body that trips each. Hoisted because this list stood twice,
// verbatim, in the detection tests and again in the mutation cases — two copies drift.
const CREDENTIAL_FIXTURES: Array<[string, string]> = [
  ['private-key-block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxSentinelKeyBody\n'],
  ['aws-access-key-id', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n'],
  ['json-web-token', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.QWxs\n'],
  ['bearer-token', `Authorization: Bearer ${SENTINEL_TOKEN}\n`],
  ['credential-assignment', `client_secret: "${SENTINEL_TOKEN}"\n`],
  ['basic-auth-url', 'https://admin:hunter2pass@acme.zendesk.com/api/v2\n'],
  ['zendesk-api-token-pair', `me@acme.com/token:${SENTINEL_TOKEN}\n`],
];

const SENTINELS = [
  SENTINEL_TOKEN,
  'AKIAIOSFODNN7EXAMPLE',
  'MIIEowIBAAKCAQEAxSentinelKeyBody',
  'hunter2pass',
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
];

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// A .mcpb is a ZIP, so the fixtures are real ZIPs — written here rather than fetched through npx,
// so that every rule below is exercised deterministically and offline. The one test that must also
// prove the REAL packer produces something this auditor can read runs `mcpb pack` for itself
// (see "the real packer" below); it is the proof, and it is not allowed to skip.
// ---------------------------------------------------------------------------------------------
type ZipEntry = {
  name: string;
  data: string | Buffer;
  /** 0 stored, 8 deflate; anything else is a method this auditor must refuse. */
  method?: number;
  /** General-purpose flags: 0x01 encrypted, 0x08 data descriptor. */
  flags?: number;
  /** Write the local header but NO central-directory record (a streaming unpacker still sees it). */
  localOnly?: boolean;
  /** Write the central-directory record but NO local header — a record pointing at nothing of its own. */
  cdOnly?: boolean;
  /** Zero the LOCAL sizes and append a real 16-byte data descriptor after the data. */
  descriptor?: boolean;
  /** Make the directory name differ from the local one. */
  cdName?: string;
  /** Lie about the sizes, or the local-header offset, in the central directory. */
  cdCompressedSize?: number;
  cdSize?: number;
  cdLocalOffset?: number;
  /** Point this record at the local header of an earlier entry with this name. */
  cdLocalOffsetOf?: string;
};

function zip(entries: ZipEntry[], opts: { declaredCount?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let records = 0;
  const offsetOf = new Map<string, number>();
  for (const entry of entries) {
    const plain = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.method ?? 0;
    const body = method === 8 ? deflateRawSync(plain) : plain;
    const name = Buffer.from(entry.name, 'utf8');
    const sum = crc32(plain);
    const flags = entry.flags ?? 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entry.descriptor ? 0 : sum, 14);
    local.writeUInt32LE(entry.descriptor ? 0 : body.length, 18);
    local.writeUInt32LE(entry.descriptor ? 0 : plain.length, 22);
    local.writeUInt16LE(name.length, 26);
    if (!entry.cdOnly) locals.push(local, name, body);
    if (entry.descriptor && !entry.cdOnly) {
      // The real thing: signature, CRC and both sizes, written AFTER the data. This is what makes
      // the data-descriptor fixture an archive of that shape rather than a flag on an ordinary one.
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(sum, 4);
      dd.writeUInt32LE(body.length, 8);
      dd.writeUInt32LE(plain.length, 12);
      locals.push(dd);
    }

    const at = offset;
    if (!entry.cdOnly) {
      offsetOf.set(entry.name, at);
      offset += 30 + name.length + body.length + (entry.descriptor ? 16 : 0);
    }
    if (entry.localOnly) continue;
    records++;

    const cdName = Buffer.from(entry.cdName ?? entry.name, 'utf8');
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(sum, 16);
    cd.writeUInt32LE(entry.cdCompressedSize ?? body.length, 20);
    cd.writeUInt32LE(entry.cdSize ?? plain.length, 24);
    cd.writeUInt16LE(cdName.length, 28);
    const pointsAt = entry.cdLocalOffsetOf === undefined ? undefined : offsetOf.get(entry.cdLocalOffsetOf);
    if (entry.cdLocalOffsetOf !== undefined && pointsAt === undefined) {
      throw new Error(`fixture error: no earlier entry named ${entry.cdLocalOffsetOf}`);
    }
    cd.writeUInt32LE(pointsAt ?? entry.cdLocalOffset ?? at, 42);
    central.push(cd, cdName);
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.declaredCount ?? records, 8);
  eocd.writeUInt16LE(opts.declaredCount ?? records, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const bundledManifest = (version: string): string =>
  JSON.stringify({
    manifest_version: '0.3',
    name: 'zendesk',
    version,
    description: 'd',
    author: { name: 'a' },
    server: { type: 'node' },
  });

// The measured shape of the real bundle in miniature: four files above dist/ and node_modules/,
// compiled JavaScript, and a dependency entry that is DEFLATEd so the happy path covers method 8.
const clean = (version = '1.0.0'): ZipEntry[] => [
  { name: 'manifest.json', data: bundledManifest(version) },
  { name: 'package.json', data: JSON.stringify({ name: 'zendesk-plugin', version }) },
  { name: 'LICENSE', data: 'MIT\n' },
  { name: 'README.md', data: '# zendesk\n' },
  { name: 'dist/server.js', data: 'export {};\n' },
  { name: 'node_modules/zod/index.js', data: 'module.exports = {};\n', method: 8 },
];

type Run = { status: number; stdout: string; stderr: string };
type Tree = { dir: string; bundle: string; artifact: string; checksum: string };

function makeTree(opts: {
  entries?: ZipEntry[];
  raw?: Buffer;
  zipOpts?: { declaredCount?: number };
  manifestVersion?: string;
  packageVersion?: string;
  /** The name the bundle is written under. The release slot is the TREE's and does not follow it. */
  bundleName?: string;
  // Each pair is asserted to be present before it is applied, so a mutation whose anchor has
  // drifted fails loudly instead of running the unmutated script and passing.
  mutate?: Array<[string, string]>;
} = {}): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-audit-'));
  temps.push(dir);
  mkdirSync(join(dir, 'scripts'));

  if (opts.mutate?.length) {
    let code = readFileSync(AUDIT, 'utf8');
    for (const [find, replace] of opts.mutate) {
      expect(code, `mutation anchor missing: ${find.slice(0, 70)}`).toContain(find);
      code = code.replace(find, replace);
    }
    writeFileSync(join(dir, 'scripts', 'audit-bundle.mjs'), code);
  } else {
    copyFileSync(AUDIT, join(dir, 'scripts', 'audit-bundle.mjs'));
  }

  const version = opts.manifestVersion ?? '1.0.0';
  writeFileSync(join(dir, 'manifest.json'), bundledManifest(version));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'zendesk-plugin', version: opts.packageVersion ?? '1.0.0' }),
  );
  const bundle = join(dir, opts.bundleName ?? 'zendesk.mcpb');
  writeFileSync(bundle, opts.raw ?? zip(opts.entries ?? clean(), opts.zipOpts));
  return {
    dir,
    bundle,
    artifact: join(dir, `zendesk-${version}.mcpb`),
    checksum: join(dir, `zendesk-${version}.mcpb.sha256`),
  };
}

// `cwd` IS THE TREE, and it has to be stated now rather than inherited (#105 AC5). A relative
// positional argument used to be resolved against the SCRIPT's own tree, so this harness got the
// fixture's bundle by accident while a real operator in any other directory got `<repo>/x.mcpb`.
// The argument resolves against the caller's cwd now, so the caller here says where it stands.
function runAudit(tree: Tree, args: string[] = ['zendesk.mcpb'], cwd: string = tree.dir): Run {
  const run = spawnSync('node', [join(tree.dir, 'scripts', 'audit-bundle.mjs'), ...args], {
    encoding: 'utf8',
    cwd,
  });
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

/** Runs the real audit over a tree built from `entries`, and returns the run. */
function audit(entries: ZipEntry[]): Run {
  return runAudit(makeTree({ entries }));
}

// Every failing run in this file goes through here: no sentinel may appear in either stream.
function expectNoSecretEchoed(run: Run): void {
  for (const sentinel of SENTINELS) {
    expect(run.stdout, 'stdout echoed planted credential material').not.toContain(sentinel);
    expect(run.stderr, 'stderr echoed planted credential material').not.toContain(sentinel);
  }
}

// =============================================================================================
// Scenario: a clean bundle passes
// =============================================================================================
describe('a clean bundle passes', () => {
  it('exits 0 and prints every path it accepted, each with the rule that accepted it', () => {
    const run = runAudit(makeTree());
    expect(run.status).toBe(0);
    // Counted in full; listed in full for everything that is not a dependency. On the real bundle
    // the listing is 72 lines instead of 1930, and the dependency count is still stated.
    expect(run.stdout).toContain('Accepted 6 paths, of which 1 are node_modules/** [runtime-dependencies].');
    expect(run.stdout).toContain('The other 5, in full:');
    for (const [path, rule] of [
      ['manifest.json', 'manifest'],
      ['package.json', 'package-metadata'],
      ['LICENSE', 'license'],
      ['README.md', 'readme'],
      ['dist/server.js', 'compiled-server'],
    ]) {
      expect(run.stdout).toContain(`  ${path} [${rule}]`);
    }
    expect(run.stdout).not.toContain('node_modules/zod/index.js [');
  });

  it('reads DEFLATEd entries, not only stored ones', () => {
    // node_modules/zod/index.js in the clean fixture is method 8. If inflate were broken the entry
    // would be unreadable, and an unreadable entry is a failure — so exit 0 is the assertion.
    const run = audit([
      ...clean().filter((e) => !e.name.startsWith('node_modules/')),
      { name: 'node_modules/zod/index.js', data: `// ${'x'.repeat(4000)}\n`, method: 8 },
    ]);
    expect(run.status).toBe(0);
  });
});

// =============================================================================================
// Scenario: a planted secret is caught — the mandatory proof
// =============================================================================================
describe('a planted secret is caught', () => {
  it('refuses a bundle carrying tokens.enc, and names the path', () => {
    const run = audit([...clean(), { name: 'tokens.enc', data: `token = "${SENTINEL_TOKEN}"\n` }]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('tokens.enc [encrypted-token-store]');
    expectNoSecretEchoed(run);
  });

  it('names the offending path and the matching rule for credential material in a shipped file', () => {
    // README.md is allowlisted and is NOT excluded by .mcpbignore — exactly the scenario's shape:
    // the path is legitimate, the content is not.
    const run = audit([
      ...clean().filter((e) => e.name !== 'README.md'),
      { name: 'README.md', data: `# zendesk\n\nZENDESK_API_TOKEN = "${SENTINEL_TOKEN}"\n` },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('README.md:3 [credential-assignment]');
    expectNoSecretEchoed(run);
  });

  it.each(CREDENTIAL_FIXTURES)('catches %s and reports path and rule only, never the value', (rule, body) => {
    const run = audit([...clean().filter((e) => e.name !== 'README.md'), { name: 'README.md', data: body }]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(new RegExp(`README\\.md:\\d+ \\[${rule}\\]`));
    expectNoSecretEchoed(run);
  });

  it('produces no artifact, no checksum, and leaves nothing uploadable behind', () => {
    const tree = makeTree({ entries: [...clean(), { name: 'tokens.enc', data: 'x' }] });
    const run = runAudit(tree);
    expect(run.status).not.toBe(0);
    expect(existsSync(tree.artifact)).toBe(false);
    expect(existsSync(tree.checksum)).toBe(false);
    // Clearing only the versioned copy left zendesk.mcpb — the file package.json:19 produces and
    // the one somebody would upload — sitting there with the secret in it. It is renamed rather
    // than deleted so whoever has to find out how it got in still has the evidence.
    expect(existsSync(tree.bundle)).toBe(false);
    expect(existsSync(`${tree.bundle}.REJECTED`)).toBe(true);
    expect(run.stderr).toContain('CONTAMINATED');
  });

  it('removes an artifact left by an earlier passing run, so a refusal leaves nothing shippable', () => {
    const tree = makeTree({ entries: [...clean(), { name: 'tokens.enc', data: 'x' }] });
    writeFileSync(tree.artifact, 'stale bundle from the run before');
    writeFileSync(tree.checksum, 'stale checksum');
    expect(runAudit(tree).status).not.toBe(0);
    expect(existsSync(tree.artifact)).toBe(false);
    expect(existsSync(tree.checksum)).toBe(false);
  });
});

// =============================================================================================
// Scenario: a forbidden path is caught even if the content looks harmless
// =============================================================================================
describe('forbidden paths, at any depth, whatever the content', () => {
  it.each([
    ['tokens.enc', 'encrypted-token-store'],
    ['a/b/c/tokens.enc', 'encrypted-token-store'],
    ['dist/cache/entry.enc', 'encrypted-token-store'],
    ['.env.local', 'dotenv-file'],
    ['dist/.env', 'dotenv-file'],
    ['certs/server.pem', 'private-key-material'],
    ['dist/tls/api.key', 'private-key-material'],
    ['home/.ssh/id_rsa', 'private-key-material'],
    ['home/.ssh/id_ed25519.pub', 'private-key-material'],
    // Inside node_modules the allowlist WOULD accept these. The forbidden list is what refuses them.
    ['node_modules/some-dep/.npmrc', 'npm-credentials-file'],
    ['node_modules/some-dep/.git/config', 'git-directory'],
    ['.zendesk-plugin-data/cache/zendesk_get_me-a1b2.json', 'runtime-data-directory'],
    ['dist/.zendesk-plugin-data/audit/write-audit.jsonl', 'runtime-data-directory'],
    ['users/17/profile.json', 'user-data-directory'],
    ['issued/2026-09-23.json', 'issued-credential-directory'],
    ['coverage/lcov.info', 'coverage-output'],
    ['dist/coverage/lcov-report/index.html', 'coverage-output'],
  ])('refuses %s as [%s]', (path, rule) => {
    // The content is deliberately innocuous: the path alone must be enough.
    const run = audit([...clean(), { name: path, data: 'nothing to see here\n' }]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(`forbidden path in bundle: ${path} [${rule}]`);
  });

  it('does not mistake a FILE named like a forbidden directory for one', () => {
    // `users/**` is a directory rule; a file called `users` carries nothing. It is still refused —
    // by the allowlist — but crediting the directory rule with it would be a false report.
    const run = audit([...clean(), { name: 'dist/users', data: 'x' }]);
    expect(run.stderr).not.toContain('[user-data-directory]');
    expect(run.stderr).toContain('path matches no allowlist rule, refused by default: dist/users');
  });
});

// =============================================================================================
// Scenario: anything outside the allowlist is refused
// =============================================================================================
describe('default deny', () => {
  it.each([
    'src/server.ts', // a whole directory the allowlist never names
    'notes.txt', // a stray file at the root, beside the four that are allowed
    'dist/types.d.ts', // inside an allowed directory, wrong extension
    'zendesk-1.0.0.mcpb.sha256', // the audit's own output, packed back in by the next run
  ])('refuses %s because no allowlist rule matches it', (path) => {
    const run = audit([...clean(), { name: path, data: 'harmless\n' }]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(`path matches no allowlist rule, refused by default: ${path}`);
  });

  it('refuses an unknown path that no forbidden rule names — refusal is the default, not the exception', () => {
    const run = audit([...clean(), { name: 'vendor/thing.bin', data: 'harmless\n' }]);
    expect(run.status).not.toBe(0);
    // Nothing in FORBIDDEN mentions vendor/. If the default were "accept", this bundle would ship.
    expect(run.stderr).not.toContain('forbidden path in bundle');
    expect(run.stderr).toContain('refused by default: vendor/thing.bin');
  });
});

// =============================================================================================
// An empty or unreadable archive is a failure, not a pass
// =============================================================================================
describe('an archive that cannot be judged is refused', () => {
  it('refuses an archive with no entries instead of reporting "no secrets found"', () => {
    const run = runAudit(makeTree({ entries: [] }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('contains no entries');
    expect(run.stdout).not.toContain('audit passed');
  });

  it('refuses a file that is not a ZIP at all, as a message and not a stack trace', () => {
    const run = runAudit(makeTree({ raw: Buffer.from('this is not an archive'.repeat(10)) }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('no ZIP end-of-central-directory record');
    expect(run.stderr).not.toMatch(/^\s+at .*\(node:/m);
  });

  it('refuses a file too small to be an archive', () => {
    const run = runAudit(makeTree({ raw: Buffer.from('PK') }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('smaller than an empty ZIP archive');
  });

  // A NAME THAT IS NOT THERE IS NOT AN UNFIT BUNDLE (#105). It used to be reported as "could not
  // be read as a bundle" in the same breath as a truncated ZIP, in the same list that moves files.
  // It is a tree fault now: exit 2, named, and nothing touched.
  it('refuses a missing bundle as a tree fault, as a message and not a stack trace', () => {
    const run = runAudit(makeTree(), ['no-such-bundle.mcpb']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('there is nothing at');
    expect(run.stderr).toContain('Cannot release from this tree');
    expect(run.stderr).not.toContain('CONTAMINATED');
    expect(run.stderr).not.toMatch(/^\s+at .*\(node:/m);
  });

  it('refuses a directory whose record count disagrees with the records it holds', () => {
    const buf = zip(clean());
    // BOTH count fields, so the EOCD stays self-consistent and the fixture reaches the check it is
    // about rather than the one next to it.
    for (const at of [8, 10]) buf.writeUInt16LE(buf.readUInt16LE(buf.length - 22 + at) + 1, buf.length - 22 + at);
    const run = runAudit(makeTree({ raw: buf }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('claims 7 entries, the directory holds 6');
  });

  it('refuses an archive with no manifest.json — the host would have nothing to install', () => {
    const run = audit(clean().filter((e) => e.name !== 'manifest.json'));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('carries no manifest.json');
  });
});

// =============================================================================================
// The reader is fail-closed: it sees every entry a real unpacker sees, or it refuses the archive.
// Each shape below shipped a secret past the first version of this auditor with exit 0, and each
// is cross-checked against python3 zipfile / unzip / bsdtar outside the suite.
// =============================================================================================
describe('the reader sees what a real unpacker sees, or refuses', () => {
  const SECRET_ENTRY: ZipEntry = { name: 'secret.txt', data: PLANTED };

  it('refuses a directory the EOCD count understates, instead of stopping at the count', () => {
    // BLOCKER: the loop was bounded by the count, so the 7th record — and its secret — was never
    // looked at. python3 zipfile and unzip both list it. Parsing by directory SIZE finds it, and
    // the disagreement is then itself the refusal.
    const run = runAudit(makeTree({ entries: [...clean(), SECRET_ENTRY], zipOpts: { declaredCount: 6 } }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('claims 6 entries, the directory holds 7');
    expectNoSecretEchoed(run);
  });

  it('refuses an entry that exists only in the local headers', () => {
    // bsdtar streams it out; a directory-only reader never hears about it.
    const run = audit([...clean(), { ...SECRET_ENTRY, name: 'tokens.enc', localOnly: true }]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('present in the local headers but absent from the central directory');
  });

  it('refuses an entry whose local name differs from its directory name', () => {
    const run = audit([...clean(), { ...SECRET_ENTRY, name: 'tokens.enc', cdName: 'dist/ok.js' }]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('local header names tokens.enc where the central directory names dist/ok.js');
  });

  it('refuses a data-descriptor entry rather than scanning the zero bytes it declares', () => {
    // BLOCKER: with bit 3 set the directory may declare size 0 while the bytes sit in the stream.
    // The scan then read nothing and reported nothing — silence indistinguishable from a clean
    // file. `cat f | bsdtar -xOf - README.md` prints the token.
    const run = audit([
      ...clean().filter((e) => e.name !== 'README.md'),
      { name: 'README.md', data: PLANTED, flags: 0x08, descriptor: true, cdCompressedSize: 0, cdSize: 0 },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('uses a data descriptor');
    expectNoSecretEchoed(run);
  });

  it('refuses a directory record that declares content in zero compressed bytes', () => {
    // There is no rule of its own for this: the local-header tiling refuses it, because the next
    // header is not where a zero-length entry says it should be. Measured in four shapes — scanned
    // entry, node_modules entry, last entry, one-byte body — and the tiling check caught all four,
    // so a dedicated rule was only a second message for the same refusal.
    const run = audit([
      ...clean().filter((e) => e.name !== 'README.md'),
      { name: 'README.md', data: PLANTED, cdCompressedSize: 0 },
    ]);
    expect(run.status).not.toBe(0);
    // The walk names the entry it came from, which here IS the entry that lied about its size —
    // the diagnosis the deleted rule used to carry, at no extra rule.
    expect(run.stderr).toContain('expected a local file header after README.md');
  });

  it('refuses an entry whose real byte count disagrees with its declaration', () => {
    const run = audit([
      ...clean().filter((e) => e.name !== 'README.md'),
      { name: 'README.md', data: PLANTED, cdSize: 4 },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/holds \d+ bytes where the directory declares 4/);
  });

  it('refuses an encrypted entry instead of treating unreadable as clean', () => {
    const run = audit([
      ...clean().filter((e) => e.name !== 'README.md'),
      { name: 'README.md', data: PLANTED, flags: 0x01 },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('is encrypted and cannot be inspected');
  });

  it.each([
    'dist/../../../../tmp/pwn.js',
    '/etc/pwn.js',
    'dist/./../../pwn.js',
  ])('refuses the unsafe entry name %s, which the allowlist would otherwise admit', (name) => {
    const run = audit([...clean(), { name, data: 'export {};\n' }]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('unsafe entry name, refused');
  });

  it('refuses binary content where only text belongs, rather than silently not scanning it', () => {
    // `dist/tokens.enc.js` cleared the allowlist on its extension and the scan on its NUL byte.
    const run = audit([
      ...clean(),
      { name: 'dist/tokens.enc.js', data: Buffer.concat([Buffer.from([1, 2, 0, 3]), Buffer.from(PLANTED)]) },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('binary content where only text belongs');
    expect(run.stderr).toContain('dist/tokens.enc.js');
    expectNoSecretEchoed(run);
  });

  // Directory markers. The audit skipped these entirely — not accepted, not refused, absent from
  // the output — and `grep "path.endsWith('/')"` over this file found nothing: the one line with
  // no fixture was the one carrying the defect. They are judged like every other entry now.
  describe('directory markers are judged, not waved past', () => {
    const marker = (name: string): ZipEntry => ({ name, data: '' });

    it.each([
      ['.zendesk-plugin-data/', 'forbidden path in bundle: .zendesk-plugin-data/ [runtime-data-directory]'],
      ['coverage/', 'forbidden path in bundle: coverage/ [coverage-output]'],
      ['dist/users/', 'forbidden path in bundle: dist/users/ [user-data-directory]'],
      ['../../../../tmp/pwned/', 'is a parent-directory segment'],
      ['/etc/pwned/', 'is an absolute path'],
      ['secrets/', 'refused by default: secrets/'],
    ])('refuses the zero-byte marker %s', (name, expected) => {
      const run = audit([...clean(), marker(name)]);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(expected);
    });

    it('accepts a marker inside a tree that is itself allowed, and counts it', () => {
      const run = audit([...clean(), marker('dist/auth/'), marker('node_modules/zod/')]);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('Accepted 8 paths');
      expect(run.stdout).toContain('dist/auth/ [directory-marker]');
    });

    it('refuses a marker that carries a payload', () => {
      const run = audit([...clean(), { name: 'dist/auth/', data: PLANTED }]);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/directory marker carrying \d+ bytes of content: dist\/auth\//);
      expectNoSecretEchoed(run);
    });

    it('does not read a trailing slash as an empty path segment', () => {
      // unsafePath() refuses empty segments; without stripping the marker's trailing slash first,
      // every legitimate marker would be reported as unsafe instead of judged on its path.
      expect(audit([...clean(), marker('dist/auth/')]).stderr).not.toContain('empty path segment');
      expect(audit([...clean(), { name: 'dist//auth.js', data: 'x' }]).stderr).toContain('an empty path segment');
    });
  });

  // Patches on a well-formed archive: these lies live in the EOCD and the directory records
  // themselves, which is below what the builder models.
  const eocdAt = (buf: Buffer): number => buf.length - 22;
  const withZip64Sentinel = (): Buffer => {
    const buf = zip(clean());
    buf.writeUInt32LE(0xffffffff, eocdAt(buf) + 16); // central-directory offset
    return buf;
  };
  const withOverstatedDirectory = (): Buffer => {
    const buf = zip(clean());
    buf.writeUInt32LE(buf.readUInt32LE(eocdAt(buf) + 12) + 400, eocdAt(buf) + 12);
    return buf;
  };
  const withJunkedRecordSignature = (): Buffer => {
    const buf = zip(clean());
    buf.writeUInt32LE(0xdeadbeef, buf.readUInt32LE(eocdAt(buf) + 16));
    return buf;
  };

  it('refuses a ZIP64 sentinel in the end-of-central-directory', () => {
    const run = runAudit(makeTree({ raw: withZip64Sentinel() }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('ZIP64 archive — this auditor reads 32-bit ZIP only');
  });

  it('refuses a directory that claims to extend past the end of the file', () => {
    const run = runAudit(makeTree({ raw: withOverstatedDirectory() }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('the central directory runs past the end of the file');
  });

  it('refuses a directory record without a directory signature', () => {
    const run = runAudit(makeTree({ raw: withJunkedRecordSignature() }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('central directory record 1 is malformed');
  });

  it.each([
    ['its compressed size', { cdCompressedSize: 0xffffffff }],
    ['its uncompressed size', { cdSize: 0xffffffff }],
    ['its local-header offset', { cdLocalOffset: 0xffffffff }],
  ])('refuses a ZIP64 sentinel in %s', (_label, lie) => {
    const run = audit([...clean(), { name: 'dist/x.js', data: 'export {};\n', ...lie }]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('ZIP64 sentinel in the central directory');
  });

  it('refuses a compression method it cannot decode, rather than guessing at the bytes', () => {
    // Method 12 is BZIP2. Refusing is the whole design: every branch added to this reader is a
    // REFUSAL, never a new decoder — the interpreting surface stays the size it was.
    const run = audit([...clean(), { name: 'dist/x.js', data: 'export {};\n', method: 12 }]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('unsupported ZIP compression method 12');
  });

  it('refuses a directory record whose local header the walk never reaches', () => {
    // Two records with the same name pointing at ONE local header: the walk visits that header
    // once, so the other record never gets a data window. Reading it would mean reading the wrong
    // entry's bytes, and leaving it unread would mean not scanning a record the directory lists.
    const run = audit([
      ...clean(),
      { name: 'dist/ok.js', data: 'export {};\n' },
      { name: 'dist/ok.js', data: 'export {};\n', cdOnly: true, cdLocalOffsetOf: 'dist/ok.js' },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('its local file header is unreachable');
  });

  it('refuses a multi-part archive, whose other volumes it was never handed', () => {
    const buf = zip(clean());
    buf.writeUInt16LE(1, buf.length - 22 + 4);
    const run = runAudit(makeTree({ raw: buf }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('multi-part ZIP archive');
  });

  it('refuses an end-of-central-directory that disagrees with itself about the entry count', () => {
    const buf = zip(clean());
    buf.writeUInt16LE(3, buf.length - 22 + 8); // entries on this disk
    const run = runAudit(makeTree({ raw: buf }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('disagrees with itself');
  });

  it('refuses a control character in an entry name, which its own report would hide', () => {
    // Measured: `dist/a\0b.js` was accepted and printed as `dist/a b.js`, so the inventory named
    // a file that is not the file in the archive. A newline would forge findings outright.
    const run = audit([...clean(), { name: 'dist/a\u0000b.js', data: 'export {};\n' }]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('a control character in the name');
    const forged = audit([...clean(), { name: 'dist/a\nb.js', data: 'export {};\n' }]);
    expect(forged.status).not.toBe(0);
  });

  it('accepts an archive with an ordinary trailing comment', () => {
    // The EOCD scan walks backwards; a legitimate comment must not turn into a refusal.
    const buf = Buffer.concat([zip(clean()), Buffer.from('x'.repeat(30))]);
    buf.writeUInt16LE(30, buf.length - 30 - 22 + 20);
    expect(runAudit(makeTree({ raw: buf })).status).toBe(0);
  });

  it('caps inflate output instead of letting a decompression bomb kill the run', () => {
    // A lying declared size is the bomb's delivery mechanism; maxOutputLength turns an OOM into
    // a finding the operator can read.
    // node_modules/** is never decompressed at all (it is out of the scan's scope), so the bomb
    // has to sit where the scan does read: an allowlisted dist/*.js.
    const run = audit([...clean(), { name: 'dist/big.js', data: '\n'.repeat(200_000), method: 8, cdSize: 16 }]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('dist/big.js: expands past the 16 bytes it declares');
    expect(run.stderr).not.toContain('JavaScript heap out of memory');
  });
});

// =============================================================================================
// Feature: the artifact is versioned and verifiable
// =============================================================================================
describe('the versioned artifact and its checksum', () => {
  it('names the artifact after the version and writes a checksum that recomputes', () => {
    const tree = makeTree();
    const run = runAudit(tree);
    expect(run.status).toBe(0);
    expect(existsSync(tree.artifact)).toBe(true);

    const bytes = readFileSync(tree.artifact);
    const recomputed = createHash('sha256').update(bytes).digest('hex');
    // Recomputed over the artifact on disk, not read back from what the build printed.
    expect(readFileSync(tree.checksum, 'utf8')).toBe(`${recomputed}  zendesk-1.0.0.mcpb\n`);
    expect(bytes.equals(readFileSync(tree.bundle))).toBe(true);
    expect(run.stdout).toContain(`sha256    ${recomputed}`);
  });

  it('writes the checksum in the format `shasum -a 256 -c` verifies', () => {
    const tree = makeTree();
    expect(runAudit(tree).status).toBe(0);
    const check = spawnSync('shasum', ['-a', '256', '-c', tree.checksum], { cwd: tree.dir, encoding: 'utf8' });
    // Behaviour, not shape: the platform's own tool accepts the sidecar and confirms the artifact.
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout).toContain('OK');
  });

  it('carries the version in the artifact name AND in the bundled manifest', () => {
    const tree = makeTree({ manifestVersion: '2.3.4', packageVersion: '2.3.4', entries: clean('2.3.4') });
    expect(runAudit(tree).status).toBe(0);
    expect(existsSync(join(tree.dir, 'zendesk-2.3.4.mcpb'))).toBe(true);
    expect(existsSync(join(tree.dir, 'zendesk-2.3.4.mcpb.sha256'))).toBe(true);
  });
});

describe('a version mismatch blocks the release', () => {
  // The rule "manifest.json and package.json must agree" stood here until #68 split the two version
  // families on purpose: the MCPB extension is out of that issue's scope and keeps 1.0.1 while the
  // plugin moved to 1.1.0. What the BUNDLE has to be right about is its own manifest, and that is the
  // next case — package.json's number is not shipped inside the bundle at all.

  // AND IT IS NOT CALLED CONTAMINATION. The bundle is still refused and still quarantined — it may
  // not be uploaded as a release it is not — but nothing is in it that should not be, so the word
  // and the `.mcpbignore` hint were both false for this case (#105). Asserted here rather than in a
  // second case with a byte-identical fixture.
  it('fails when the bundled manifest disagrees with the tree, without calling it contaminated', () => {
    const tree = makeTree({ entries: clean('0.9.0') });
    const run = runAudit(tree);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('the bundled manifest.json says 0.9.0, the tree declares 1.0.0');
    expect(existsSync(tree.artifact)).toBe(false);
    expect(run.stderr).toContain('NOT THE RELEASE THIS TREE DESCRIBES');
    expect(run.stderr).toContain('it is the wrong build');
    expect(run.stderr).not.toContain('CONTAMINATED');
    expect(run.stderr).not.toContain('a refused path is usually .mcpbignore');
    expect(existsSync(`${tree.bundle}.REJECTED`)).toBe(true);
  });

  it('fails when the tree disagrees with the tag it was asked to release', () => {
    const tree = makeTree();
    const run = runAudit(tree, ['zendesk.mcpb', '--expect-version', 'v1.0.0-typo']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('the release was asked for v1.0.0-typo, the tree declares 1.0.0');
    expect(existsSync(tree.artifact)).toBe(false);
  });

  it('passes when the tag agrees', () => {
    expect(runAudit(makeTree(), ['zendesk.mcpb', '--expect-version', '1.0.0']).status).toBe(0);
  });

  it('refuses a tree whose package.json it cannot read, rather than releasing an unversioned bundle', () => {
    const tree = makeTree();
    rmSync(join(tree.dir, 'package.json'));
    const run = runAudit(tree);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('package.json is missing or unreadable');
  });
});

// =============================================================================================
// Documented limits — pinned as limits, so they stay decisions instead of becoming surprises
// =============================================================================================
describe('documented limits', () => {
  it('does not content-scan node_modules — the allowlist and the forbidden list carry it there', () => {
    const run = audit([
      ...clean().filter((e) => !e.name.startsWith('node_modules/')),
      { name: 'node_modules/some-dep/fixture.js', data: PLANTED },
    ]);
    expect(run.status).toBe(0);
  });

  it.each([
    ['an unquoted assignment', `access_token=${SENTINEL_TOKEN}\n`],
    ['a bare token literal with no keyword', `const t = "${SENTINEL_TOKEN}";\n`],
    ['an all-lowercase value with no digit', 'access_token = "abcdefghijklmnopqrstuvwxyzabcd"\n'],
  ])('lets %s through — a gap named in the header, not an accident', (_label, body) => {
    const run = audit([...clean().filter((e) => e.name !== 'README.md'), { name: 'README.md', data: body }]);
    expect(run.status).toBe(0);
  });

  it('catches a secret containing a brace — only a bare ${...} placeholder is skipped', () => {
    // The first version excluded braces from the value class, which let every brace-bearing secret
    // through. Skipping only the pure placeholder is the same length and strictly stricter.
    const withBrace = `access_token = "aB3dEfGh1jKl}n0pQrStUvWxYz456789"\n`;
    const run = audit([...clean().filter((e) => e.name !== 'README.md'), { name: 'README.md', data: withBrace }]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('[credential-assignment]');

    // ...while the MCPB user-config template in manifest.json stays quiet.
    const placeholder = 'const e = { ZENDESK_OAUTH_CLIENT_SECRET: "${user_config.oauth_client_secret}" };\n';
    expect(audit([...clean(), { name: 'dist/env.js', data: placeholder }]).status).toBe(0);
  });

  it('does not report a lowercase identifier as a credential', () => {
    // dist/auth/config.js maps ZENDESK_OAUTH_CLIENT_SECRET to the field name 'oauth_client_secret'.
    // A standing false positive here is how a guard gets switched off.
    const run = audit([
      ...clean(),
      { name: 'dist/config.js', data: "const f = { ZENDESK_OAUTH_CLIENT_SECRET: 'oauth_client_secret' };\n" },
    ]);
    expect(run.status).toBe(0);
  });

  it('still catches a real secret further down a file whose first match was an identifier', () => {
    const run = audit([
      ...clean(),
      {
        name: 'dist/config.js',
        data: `const f = { CLIENT_SECRET: 'oauth_client_secret' };\nconst t = { api_key: "${SENTINEL_TOKEN}" };\n`,
      },
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('dist/config.js:2 [credential-assignment]');
    expectNoSecretEchoed(run);
  });
});

// =============================================================================================
// Wiring: the audit runs before anything is published, and it runs in CI
// =============================================================================================
describe('the audit is wired in front of publication', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  it('runs as the last link of the existing pack chain, not as a second chain beside it', () => {
    expect(pkg.scripts.pack as string).toMatch(
      /^node scripts\/validate-manifests\.mjs && node scripts\/assert-prod-tree\.mjs && npx .*@anthropic-ai\/mcpb.* pack \. zendesk\.mcpb && node scripts\/audit-bundle\.mjs zendesk\.mcpb$/,
    );
  });

  it('is the only thing that produces the shippable artifact, so an unaudited bundle is never one', () => {
    // `mcpb pack` writes zendesk.mcpb; the versioned copy exists only if the audit passed.
    expect(pkg.scripts.pack as string).not.toContain('zendesk-1.0.0.mcpb');
  });

  it('runs in CI, and the local release path checks every version site the way CI does', () => {
    expect(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')).toContain('npm run pack');
    // validate-manifests.mjs was CI's first step but not part of `npm run pack`, so the local run
    // that produces the uploadable artifact checked three of the seven version sites.
    expect(pkg.scripts.pack as string).toContain('scripts/validate-manifests.mjs');
  });

  it('adds no dependency: the script imports Node builtins and nothing else', () => {
    // The actual claim, rather than a hand-kept copy of both dependency lists — the bookkeeping
    // that scripts/assert-prod-tree.mjs:13-16 rejects in its own comment for the same reason.
    const imports = [...readFileSync(AUDIT, 'utf8').matchAll(/^import .*? from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(3);
    for (const specifier of imports) expect(specifier).toMatch(/^node:/);
  });

  it('stamps the MCPB manifest 1.0.1 and the plugin 1.1.0, the rest held by the manifest validator', () => {
    // scripts/validate-manifests.mjs owns the fan-out across the hand-kept sites and is CI's first
    // step; tests/plugin/pack-script.test.ts drives it. Repeating it here would be a third owner for
    // one question. The two numbers differ by decision (#68): the MCPB extension is unchanged.
    expect(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version).toBe('1.0.1');
    expect(pkg.version).toBe('1.1.0');
    expect(execFileSync('node', [join(root, 'scripts', 'validate-manifests.mjs')], { encoding: 'utf8' })).toContain(
      'Version agreement',
    );
  });

  it('keeps the artifact and its checksum out of git AND out of the next bundle', () => {
    // .gitignore keeps them out of the repo; .mcpbignore keeps the sidecar out of the next pack.
    // The packer's own EXCLUDE_PATTERNS cover *.mcpb but not *.sha256, and it reads no .gitignore,
    // so without that line the next bundle ships the previous checksum and the allowlist refuses.
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^\*\.mcpb$/m);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^\*\.mcpb\.sha256$/m);
    expect(readFileSync(join(root, '.mcpbignore'), 'utf8')).toMatch(/^\*\.mcpb\.sha256$/m);
  });
});

// =============================================================================================
// The real packer. The hermetic fixtures above prove the RULES; this proves the auditor reads what
// `mcpb pack` actually writes, and that a secret planted in a checkout survives packing and is
// caught. Without it every test here could be green against a ZIP dialect the packer never emits.
// =============================================================================================
describe('the real packer', () => {
  function packTree(files: Record<string, string>): Tree {
    // The real manifest is copied in below, so the fixture package.json must carry its version.
    const version = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version as string;
    const tree = makeTree({ manifestVersion: version, packageVersion: version });
    rmSync(tree.bundle);
    // A real .mcpbignore, so the audit script itself does not end up inside the fixture bundle.
    writeFileSync(join(tree.dir, '.mcpbignore'), 'scripts/\n');
    mkdirSync(join(tree.dir, 'dist'), { recursive: true });
    writeFileSync(join(tree.dir, 'dist', 'server.js'), 'export {};\n');
    // The real manifest: `mcpb pack` validates it and refuses an incomplete one.
    copyFileSync(join(root, 'manifest.json'), join(tree.dir, 'manifest.json'));
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(tree.dir, name)), { recursive: true });
      writeFileSync(join(tree.dir, name), body);
    }
    const pack = spawnSync(
      'npx',
      ['--yes', '@anthropic-ai/mcpb@2.1.2', 'pack', '.', 'zendesk.mcpb'],
      { cwd: tree.dir, encoding: 'utf8' },
    );
    // Never skipped: if the packer cannot run, this proof did not happen and must say so.
    expect(pack.status, `mcpb pack failed:\n${pack.stdout}\n${pack.stderr}`).toBe(0);
    return tree;
  }

  it('passes a bundle the real packer produced from a clean tree', () => {
    const tree = packTree({ 'README.md': '# zendesk\n', LICENSE: 'MIT\n' });
    const run = runAudit(tree);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('dist/server.js [compiled-server]');
    expect(existsSync(tree.artifact)).toBe(true);
  }, 120_000);

  it('catches a credential planted in a checkout, packed for real — and publishes nothing', () => {
    const tree = packTree({
      'README.md': `# zendesk\n\nZENDESK_API_TOKEN = "${SENTINEL_TOKEN}"\n`,
      LICENSE: 'MIT\n',
      'tokens.enc': `refresh_token = "${SENTINEL_TOKEN}"\n`,
    });
    const run = runAudit(tree);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('forbidden path in bundle: tokens.enc [encrypted-token-store]');
    expect(run.stderr).toContain('README.md:3 [credential-assignment]');
    expect(existsSync(tree.artifact)).toBe(false);
    expect(existsSync(tree.checksum)).toBe(false);
    expect(existsSync(tree.bundle)).toBe(false);
    expect(existsSync(`${tree.bundle}.REJECTED`)).toBe(true);
    expectNoSecretEchoed(run);
  }, 120_000);
});

// =============================================================================================
// Scenario (#105): "this BUNDLE is unfit" and "this TREE cannot publish" are different verdicts,
// and only the first one moves a file. Every case here starts from a bundle that is provably
// clean — `clean()`, the same fixture that exits 0 two hundred lines above — so that a refusal
// cannot be read as a statement about the archive.
// =============================================================================================
describe('a tree that cannot publish is not a contaminated bundle', () => {
  // The four tree defects named in #105, each measured to have renamed a clean bundle to
  // .REJECTED and announced it as CONTAMINATED with .mcpbignore as the likely cause.
  const TREE_DEFECTS: Array<[string, (t: Tree) => string[] | void, string]> = [
    ['an unreadable manifest.json', (t) => void writeFileSync(join(t.dir, 'manifest.json'), '{ not json'), 'manifest.json is missing or unreadable'],
    ['an unreadable package.json', (t) => void writeFileSync(join(t.dir, 'package.json'), '{ not json'), 'package.json is missing or unreadable'],
    // Owner decision on #105: unreadable is unknown, not contaminated. The row carries the whole
    // claim — exit 2, the sentence, the file present and byte-identical, nothing renamed.
    ['a bundle path that cannot be read', (t) => void chmodSync(t.bundle, 0o000), 'unreadable is unknown, not contaminated'],
    ['a malformed --expect-version', () => ['zendesk.mcpb', '--expect-version', 'not-a-version'], 'version mismatch'],
    // The measured pair itself: with neither manifest readable the tree has no version at all,
    // which is the state in which every bundle used to be declared contaminated.
    // NOTE for whoever reads the artifact-survival assertions below: four of these five rows pin
    // the clearing guard. This one cannot — with neither manifest readable there is no version,
    // so no artifact path, so nothing for `clearStaleArtifact()` to clear. Measured: ablating the
    // guard reddens exactly 4 of the 5 rows. Named rather than left to look like coverage.
    [
      'neither manifest readable',
      (t) => {
        writeFileSync(join(t.dir, 'manifest.json'), '{ not json');
        writeFileSync(join(t.dir, 'package.json'), '{ not json');
      },
      'the release version cannot be established',
    ],
  ];

  it.each(TREE_DEFECTS)('%s leaves the clean bundle exactly where it is', (_label, breakIt, expected) => {
    const tree = makeTree();
    const before = readFileSync(tree.bundle);
    // THE OPERATOR'S PREVIOUS RELEASE, written here on purpose. `makeTree` does not create it, so
    // `expect(existsSync(tree.artifact)).toBe(false)` used to be true BEFORE the run — a vacuous
    // assertion, and the reason a typo'd --expect-version could delete both files while the output
    // said "nothing was deleted" and every row of this table stayed green.
    writeFileSync(tree.artifact, 'the release this tree published last time');
    writeFileSync(tree.checksum, 'and its checksum');
    const args = breakIt(tree) ?? undefined;
    const run = runAudit(tree, args);
    try {
      expect(run.status, run.stderr).toBe(2);
      expect(run.stderr).toContain(expected);
      expect(run.stderr).toContain('Cannot release from this tree');
      expect(run.stderr).toContain('STILL THERE');
      // Named by its full path, so an operator can act on the file that is still sitting there.
      expect(run.stderr).toContain(tree.bundle);
      // Not one word of the bundle verdict, because no bundle verdict was reached.
      expect(run.stderr).not.toContain('CONTAMINATED');
      // The exact sentence #105 names as false for the affected tree. The message IS allowed to
      // say that .mcpbignore is not the cause, which is the opposite claim.
      expect(run.stderr).not.toContain('Fix the cause (usually .mcpbignore)');
      expect(existsSync(`${tree.bundle}.REJECTED`), 'a tree fault renamed the bundle').toBe(false);
      expect(existsSync(tree.bundle)).toBe(true);
      // "nothing was deleted", asserted rather than printed.
      expect(readFileSync(tree.artifact, 'utf8')).toBe('the release this tree published last time');
      expect(readFileSync(tree.checksum, 'utf8')).toBe('and its checksum');
    } finally {
      chmodSync(tree.bundle, 0o644); // or afterEach cannot remove the tree
    }
    // Byte-identical, not merely present: the measurement in #105 was taken against a
    // byte-identical bundle and the two runs disagreed about whether it survived.
    expect(readFileSync(tree.bundle).equals(before)).toBe(true);
  });

  // THE VERSION IS A PATH COMPONENT, so it is validated — and round 2 of this review showed that
  // the whole validation was deletable with the suite green. These three cases are why it cannot
  // be deleted any more. Each one was a live blocker before it was pinned.
  describe('the declared version has to be usable as a file name', () => {
    // A SEPARATOR IS WHAT TRAVERSES, and the first two spellings of this case carried none that
    // worked. The artifact path is `join(root, `zendesk-${version}.mcpb`)`, so `../VICTIM` gives
    // `zendesk-../VICTIM.mcpb` — `zendesk-..` is a literal segment and goes nowhere, which is why
    // both earlier fixtures were inert. `0/../VICTIM` enters a segment and leaves it again, so the
    // artifact lands somewhere the version name does not appear at all. The test COMPUTES that
    // landing place and asserts it moved, then puts the victim there — an inert fixture is exactly
    // how the two earlier spellings passed.
    //
    // It deliberately stops one `..` short of leaving the tree: `0/../../VICTIM` lands in the
    // shared temp root, and the first draft of this case pushed that onto the cleanup list and
    // tried to `rm -rf` it (EPERM on `/var/folders/.../T`). The mechanism under test is the
    // separator, and one is enough to show it.
    //
    // `entries: clean(escape)` as well, or the ablated run exits 1 on a version mismatch and never
    // reaches the write.
    it('refuses a version with path segments, and overwrites nothing through one', () => {
      const escape = '0/../VICTIM';
      const tree = makeTree({ manifestVersion: escape, packageVersion: escape, entries: clean(escape) });
      const wouldLandOn = join(tree.dir, `zendesk-${escape}.mcpb`);
      // The fixture is only a fixture if the separator really moved the path.
      expect(wouldLandOn).toBe(join(tree.dir, 'VICTIM.mcpb'));
      expect(wouldLandOn).not.toContain('zendesk-');
      writeFileSync(wouldLandOn, "somebody else's file");
      writeFileSync(`${wouldLandOn}.sha256`, 'and its checksum');

      const run = runAudit(tree);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('is not a usable file-name component');
      expect(run.stderr).not.toMatch(/^\s+at .*\(node:/m);
      expect(readFileSync(wouldLandOn, 'utf8')).toBe("somebody else's file");
      expect(readFileSync(`${wouldLandOn}.sha256`, 'utf8')).toBe('and its checksum');
      expect(existsSync(tree.bundle)).toBe(true);
    });

    // The manifests PARSE here, so readJson raises nothing. This is what reached
    // `writeFileSync(null, bundle)` — ERR_INVALID_ARG_TYPE as a stack trace, under exit 1, for a
    // bundle that had passed every rule.
    it('refuses manifests that parse but declare no version, without a stack trace', () => {
      const tree = makeTree();
      writeFileSync(join(tree.dir, 'manifest.json'), JSON.stringify({ name: 't' }));
      writeFileSync(join(tree.dir, 'package.json'), JSON.stringify({ name: 't' }));
      const run = runAudit(tree);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('neither manifest.json nor package.json declares a version');
      expect(run.stderr).not.toMatch(/ERR_INVALID_ARG_TYPE|^\s+at .*\(node:/m);
      expect(existsSync(tree.bundle)).toBe(true);
    });

    it('says a non-string version is not a string, rather than blaming the file name', () => {
      const tree = makeTree();
      writeFileSync(join(tree.dir, 'manifest.json'), JSON.stringify({ name: 't', version: 100 }));
      writeFileSync(join(tree.dir, 'package.json'), JSON.stringify({ name: 't', version: 100 }));
      const run = runAudit(tree);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('is number, not a string');
      expect(run.stderr).not.toContain('not a usable file-name component');
    });

    // ONE ROW. The gate is a charset regex with no ordering, so this shape strictly covers
    // `1.0.0-rc.1` and `1.0.0+build.5`, and plain `1.0.0` is makeTree()'s default and so already
    // the subject of 'a clean bundle passes'. The case exists because a validation that bricks a
    // real release would be worse than the traversal it prevents.
    // A LENGTH IS ALSO A FILE-NAME PROPERTY. 242 characters pass the charset gate and produce a
    // 262-byte checksum name, over the 255-byte limit for one path component — with `root`
    // perfectly readable. Before this gate the run reported a "stale artifact" at a path that
    // cannot exist and never named the version.
    it('refuses a version too long to form a file name, and says that is what is wrong', () => {
      const v = 'a'.repeat(242);
      const tree = makeTree({ manifestVersion: v, packageVersion: v, entries: clean(v) });
      const run = runAudit(tree);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('the declared version is 242 characters, which makes the release name 262 bytes');
      expect(run.stderr).not.toContain('could not be cleared');
      expect(run.stderr).not.toContain('ENAMETOOLONG');
      expect(run.stderr).not.toMatch(/^\s+at .*\(node:/m);
      expect(existsSync(tree.bundle)).toBe(true);
    });

    it('still releases a full semver with prerelease and build metadata', () => {
      const v = '1.0.0-rc.1+exp.sha.5114f85';
      const tree = makeTree({ manifestVersion: v, packageVersion: v, entries: clean(v) });
      const run = runAudit(tree);
      expect(run.status, run.stderr).toBe(0);
      expect(existsSync(tree.artifact)).toBe(true);
    });
  });

  // A partial clearing is the round-1 blocker one window narrower: the artifact goes, the checksum
  // slot refuses, the failure becomes a tree fault — and the paragraph then claimed nothing had
  // been deleted while the operator's artifact was already gone. Measured.
  it('names what it already deleted when the clearing fails half way', () => {
    const tree = makeTree();
    writeFileSync(tree.artifact, 'the release this tree published');
    // The checksum slot is a non-empty directory, which `rmSync(force)` cannot remove.
    mkdirSync(tree.checksum);
    writeFileSync(join(tree.checksum, 'in-the-way'), 'x');
    const run = runAudit(tree);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('could not be cleared');
    expect(existsSync(tree.artifact), 'the artifact was removed, as the code intends').toBe(false);
    // The sentence has to match the disk.
    expect(run.stderr).not.toContain('Nothing was deleted');
    expect(run.stderr).toContain('Already removed before this run finished, and NOT coming back');
    expect(run.stderr).toContain(basename(tree.artifact));
  });

  // `wasThere` was pinned by nothing: replacing it with `true` left 188/188 green. Ablated, with
  // the artifact slot EMPTY and only the checksum slot in the way, the run claimed a release that
  // never existed had been destroyed.
  it('does not claim it removed an artifact that was never there', () => {
    const tree = makeTree();
    mkdirSync(tree.checksum); // a directory in the slot: rmSync(force) throws ERR_FS_EISDIR
    const run = runAudit(tree);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('could not be cleared');
    expect(run.stderr).not.toContain('Already removed before this run finished');
    expect(run.stderr).not.toContain(basename(tree.artifact) + ' was');
  });

  // THE SAME PARAGRAPH IN THE OTHER ARM. The deletion notice used to be interpolated only into the
  // "no bundle finding" sentence, so a run with a bundle finding AND a partial clearing deleted the
  // operator's artifact and said nothing at all about it. It rides the clearing's own fault line
  // now, which is printed in both arms.
  it('names the deletion even when the bundle also failed', () => {
    const tree = makeTree({ entries: [...clean(), { name: 'tokens.enc', data: 'x' }] });
    writeFileSync(tree.artifact, 'the release this tree published');
    mkdirSync(tree.checksum);
    const run = runAudit(tree);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('CONTAMINATED');
    expect(existsSync(tree.artifact), 'the artifact was removed, as the code intends').toBe(false);
    expect(run.stderr).toContain('Already removed before this run finished, and NOT coming back');
    expect(run.stderr).toContain(basename(tree.artifact));
  });

  // THE CELL FOUR REVIEW ROUNDS KEPT MISSING: sound tree, clear slots, a bundle finding. The
  // clearing succeeds on BOTH files — which is #90's intended behaviour, a failing run must leave
  // nothing shippable — and the only artifact sentence in the run used to be "No artifact and no
  // checksum were produced by this run", which is true of this run and silent about the operator's
  // previous release. Nothing in the three cases added for the other cells could see it, because
  // the notice lived inside a `catch` that never fired here.
  it('names what it cleared even when both slots came away clean', () => {
    const tree = makeTree({ entries: [...clean(), { name: 'tokens.enc', data: 'x' }] });
    writeFileSync(tree.artifact, 'the release this tree published');
    writeFileSync(tree.checksum, 'and its checksum');
    const run = runAudit(tree);
    expect(run.status).toBe(1);
    expect(existsSync(tree.artifact), 'a failing run leaves nothing shippable — #90').toBe(false);
    expect(existsSync(tree.checksum)).toBe(false);
    expect(run.stderr).toContain('Already removed before this run finished, and NOT coming back');
    expect(run.stderr).toContain(basename(tree.artifact));
    expect(run.stderr).toContain(basename(tree.checksum));
  });

  // And the other order of the same fault, which the previous spelling also missed: the ARTIFACT
  // slot refuses and the checksum is a real file, so the deletion happens AFTER the fault. A notice
  // read inside the catch saw only deletions that preceded it.
  it('names a deletion that happened after the fault', () => {
    const tree = makeTree();
    mkdirSync(tree.artifact);
    writeFileSync(tree.checksum, 'the checksum of an earlier release');
    const run = runAudit(tree);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('could not be cleared');
    expect(existsSync(tree.checksum), 'removed after the fault').toBe(false);
    expect(run.stderr).toContain('Already removed before this run finished, and NOT coming back');
    expect(run.stderr).toContain(basename(tree.checksum));
  });

  // THE FOURTH WAY OUT, and the reason this report is one `exit` handler rather than a call at
  // each of three `process.exit` sites: a throw between the clearing and the verdict leaves with
  // code 1 and a stack trace, downstream of all three.
  it('names what the clearing removed even when the run leaves by a throw', () => {
    const THROW: [string, string] = [
      'if (treeFaults.length === 0) clearStaleArtifact();',
      "if (treeFaults.length === 0) clearStaleArtifact();\nthrow new Error('between the clearing and the verdict');",
    ];
    const seed = (t: Tree) => {
      writeFileSync(t.artifact, 'the release this tree published');
      writeFileSync(t.checksum, 'and its checksum');
    };
    const plain = makeTree({ mutate: [THROW] });
    seed(plain);
    const baseline = runAudit(plain);
    expect(baseline.status).toBe(1);
    expect(baseline.stderr, 'the throw really did get out').toMatch(/^\s+at /m);
    expect(baseline.stderr).toContain('Already removed before this run finished, and NOT coming back');
    expect(baseline.stderr).toContain(basename(plain.artifact));

    // Ablated: the handler is declared and never registered, so nothing is listening at exit.
    const mutant = makeTree({ mutate: [THROW, ["process.on('exit', (code) => {", 'const unreported = ((code) => {']] });
    seed(mutant);
    const run = runAudit(mutant);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/^\s+at /m);
    expect(run.stderr).not.toContain('Already removed before this run finished');
  });

  // THE SLOT IS THE TREE'S, NOT THE ARGUMENT'S. With the stem taken from `basename(bundlePath)`
  // this tree's own release pair survived a failing run fully uploadable, `cleared` was empty, and
  // the survival notice looked at `build-1.0.0.mcpb` — a path nobody had ever written.
  it("clears this tree's release pair when the bundle it audits is under another name", () => {
    const tree = makeTree({ bundleName: 'build.mcpb', entries: [...clean(), { name: 'tokens.enc', data: 'x' }] });
    writeFileSync(tree.artifact, 'the release this tree published');
    writeFileSync(tree.checksum, 'and its checksum');
    const run = runAudit(tree, ['build.mcpb']);
    expect(run.status).toBe(1);
    expect(existsSync(tree.artifact), 'a failing run leaves nothing shippable — #90').toBe(false);
    expect(existsSync(tree.checksum)).toBe(false);
    expect(run.stderr).toContain('Already removed before this run finished, and NOT coming back');
    expect(run.stderr).toContain(basename(tree.artifact));
    expect(run.stderr).not.toContain('build-1.0.0');
  });

  // And the pass, which was the worse half: the tree wrote a release name it does not declare.
  it('writes the release name this tree declares, never one built from the argument', () => {
    const tree = makeTree({ bundleName: 'build.mcpb' });
    const run = runAudit(tree, ['build.mcpb']);
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(tree.artifact)).toBe(true);
    expect(existsSync(join(tree.dir, 'build-1.0.0.mcpb'))).toBe(false);
  });

  // The same stem, one message further on: the sentence that declines to write an artifact for a
  // foreign bundle announced `other-1.0.0.mcpb`, a release name this tree does not declare.
  it('names its own release slot when it declines to write one for a foreign bundle', () => {
    const tree = makeTree();
    const elsewhere = mkdtempSync(join(tmpdir(), 'audit-foreign-'));
    temps.push(elsewhere);
    copyFileSync(tree.bundle, join(elsewhere, 'other.mcpb'));
    const run = runAudit(tree, ['./other.mcpb'], elsewhere);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`the slot ${basename(tree.artifact)} belongs to the release THIS tree declares`);
    expect(run.stdout).not.toContain('other-1.0.0');
  });

  // A foreign bundle gets the FULL report. The coverage disclosure is the part its caller most
  // needs — they cannot see this tree — and an early exit had been skipping it.
  it('gives a foreign bundle the coverage disclosure it cannot get anywhere else', () => {
    const tree = makeTree();
    const elsewhere = mkdtempSync(join(tmpdir(), 'audit-coverage-'));
    temps.push(elsewhere);
    copyFileSync(tree.bundle, join(elsewhere, 'zendesk.mcpb'));
    const run = runAudit(tree, ['./zendesk.mcpb'], elsewhere);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('Accepted 6 paths');
    expect(run.stdout).toMatch(/scanned\s+\d+ of \d+ entries/);
    expect(run.stdout).toContain('No artifact was written');
  });

  // A symlink in `root` under the publishable name IS this tree's bundle, by decision: the operator
  // aimed this tree's own name at that file. Pinned so the decision is visible rather than found.
  it('treats a symlink in the tree under the publishable name as this tree\'s own', () => {
    const tree = makeTree();
    const elsewhere = mkdtempSync(join(tmpdir(), 'audit-linked-'));
    temps.push(elsewhere);
    const real = join(elsewhere, 'downloaded.mcpb');
    copyFileSync(tree.bundle, real);
    rmSync(tree.bundle);
    symlinkSync(real, tree.bundle);
    const run = runAudit(tree);
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(tree.artifact)).toBe(true);
    expect(run.stdout).not.toContain('No artifact was written');
  });

  // "No artifact and no checksum were produced" is the only line an operator reads about
  // artifacts, and on a tree-fault run the clearing is skipped on purpose, so a complete
  // uploadable pair from an earlier passing run survives. It gets named.
  it('names a surviving artifact pair instead of letting the summary imply there is none', () => {
    const tree = makeTree({ entries: [...clean(), { name: 'tokens.enc', data: 'x' }] });
    writeFileSync(join(tree.dir, 'package.json'), '{ not json');
    writeFileSync(tree.artifact, 'an earlier passing run wrote this');
    writeFileSync(tree.checksum, 'and this');
    const run = runAudit(tree);
    expect(run.status).toBe(1);
    expect(existsSync(tree.artifact)).toBe(true);
    expect(run.stderr).toContain(`${basename(tree.artifact)} is STILL THERE under this tree's release name`);
    expect(run.stderr).toContain('it is a regular file somebody can upload under that name');
    expect(run.stderr).toContain('The clearing was skipped because this tree cannot publish.');
    expect(run.stderr).toContain(`${basename(tree.checksum)} is STILL THERE`);
  });

  // THE SAME NOTICE, THE OTHER ARM. It lived inside the `problems.length > 0` paragraph, so a run
  // whose ONLY fault is in the tree — a typo'd `--expect-version` is the ordinary way in — left a
  // complete, uploadable pair from an earlier passing run intact and said nothing about it.
  it('names a surviving artifact pair on a run whose only fault is in the tree', () => {
    const tree = makeTree();
    writeFileSync(tree.artifact, 'an earlier passing run wrote this');
    writeFileSync(tree.checksum, 'and this');
    const run = runAudit(tree, ['zendesk.mcpb', '--expect-version', '1.0.O']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('version mismatch');
    expect(existsSync(tree.artifact), 'the clearing is skipped on a tree fault, on purpose').toBe(true);
    expect(run.stderr).toContain(`${basename(tree.artifact)} is STILL THERE under this tree's release name`);
    expect(run.stderr).toContain('The clearing was skipped because this tree cannot publish.');
    expect(run.stderr).toContain(`${basename(tree.checksum)} is STILL THERE`);
  });

  // BLOCKER 2 OF ROUND 5, three false claims in one paragraph: the run said the slot "was not
  // cleared because this tree cannot publish" about a path the clearing had been REFUSED BY (the
  // tree fault is the consequence of that refusal, not its cause), called a DIRECTORY "uploadable",
  // and asserted "from an earlier run" over a path nobody in the script had written. All three are
  // measured here on the artifact slot, which the three older clearing-fault cases never used.
  it('does not invert the cause, or call a directory uploadable, when the clearing is what failed', () => {
    const tree = makeTree({ entries: [...clean(), { name: 'tokens.enc', data: 'x' }] });
    mkdirSync(tree.artifact);
    writeFileSync(join(tree.artifact, 'in-the-way'), 'x');
    writeFileSync(tree.checksum, 'the checksum of an earlier release');
    const run = runAudit(tree);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('could not be cleared: ERR_FS_EISDIR');
    expect(run.stderr).toContain('The clearing reached it and was refused: ERR_FS_EISDIR.');
    expect(run.stderr).not.toContain('The clearing was skipped');
    expect(run.stderr).toContain('it is NOT a regular file, so it cannot be uploaded');
    expect(run.stderr).not.toContain('from an earlier run');
    // The other half of the same pair really was cleared, and only that half is reported as gone.
    expect(run.stderr).toContain(`NOT coming back: ${basename(tree.checksum)}`);
  });

  // The success path used to write unguarded, so an unwritable checkout, a full disk or a slot
  // that is a directory each ended a PASSING audit as a stack trace under exit 1 — the code that
  // means "this bundle did not pass".
  it('reports a write it cannot perform instead of throwing on a bundle that passed', () => {
    const tree = makeTree();
    // A read-only checkout, which is the ordinary form of this: the clearing has nothing to remove
    // and succeeds, the audit passes, and only the write fails. A slot that is a directory trips
    // the clearing first and is a different case.
    chmodSync(tree.dir, 0o555);
    try {
      const run = runAudit(tree);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('PASSED the audit, and this tree could not write the artifact');
      expect(run.stderr).not.toMatch(/^\s+at .*\(node:/m);
      expect(existsSync(tree.bundle), 'the bundle is fine and stays where it is').toBe(true);
      // Nothing half-written: a file under the release name with no checksum beside it is worse
      // than no release at all, and the stale pair was already cleared so nothing contradicts it.
      expect(existsSync(tree.artifact)).toBe(false);
      expect(existsSync(tree.checksum)).toBe(false);
    } finally {
      chmodSync(tree.dir, 0o755); // or afterEach cannot remove it
    }
  });

  // The other half of AC1, and the one that makes it a cut rather than a blanket exemption: the
  // archive verdict is untouched. An encrypted entry, a truncated ZIP, a planted credential — all
  // still quarantine and all still exit 1.
  it('still quarantines a contaminated bundle, with the same exit code as before', () => {
    const tree = makeTree({ entries: [...clean(), { name: 'tokens.enc', data: 'x' }] });
    const run = runAudit(tree);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('CONTAMINATED');
    expect(existsSync(tree.bundle)).toBe(false);
    expect(existsSync(`${tree.bundle}.REJECTED`)).toBe(true);
  });

  // BOTH AT ONCE, which is reachable: package.json unreadable is a tree fault, manifest.json
  // still carries the version, so the archive IS judged — and it is contaminated. The two
  // verdicts have to be printable together without contradicting each other. The earlier wording
  // promised "nothing was renamed and nothing was deleted" in the same output that renamed the
  // file, which is the comment-against-code defect this ticket exists to clean up.
  it('states both verdicts without one contradicting the other', () => {
    const tree = makeTree({ entries: [...clean(), { name: 'tokens.enc', data: 'x' }] });
    writeFileSync(join(tree.dir, 'package.json'), '{ not json');
    const run = runAudit(tree);
    // #105 AC 2: a contaminated bundle keeps exit 1. The archive WAS judged in this run and
    // quarantined, so the bundle verdict is the one the caller has to act on; exit 2 is reserved
    // for a run that reached no bundle verdict at all.
    expect(run.status, 'the bundle verdict wins the exit code when there is one').toBe(1);
    // The header no longer says "was not judged" in a run that judged it — that was the other half
    // of the same contradiction.
    expect(run.stderr).toContain('This tree cannot publish, whatever zendesk.mcpb contains');
    expect(run.stderr).not.toContain('was not judged');
    expect(run.stderr).toContain('package.json is missing or unreadable');
    expect(run.stderr).toContain('The archive was judged on its own, below.');
    expect(run.stderr).toContain('CONTAMINATED');
    // And it does NOT claim the BUNDLE is untouched, because it is not. Matched on the bundle's own
    // sentence rather than on the bare words "STILL THERE", which the line about a surviving
    // artifact legitimately contains — a matcher that loose forbids a true statement.
    expect(run.stderr).not.toMatch(/whatever is at .* is STILL THERE/);
    expect(existsSync(tree.bundle)).toBe(false);
    expect(existsSync(`${tree.bundle}.REJECTED`)).toBe(true);
  });

  // The third answer of the name check, reached with a real EACCES rather than by injection: the
  // directory holding the bundle cannot be listed, so lstat itself throws. "Cannot determine" must
  // collapse into neither "fine" (release it) nor "contaminated" (move it). PR #102's two-valued
  // check answered "taken" here and fired the quarantine on a path nobody had looked at.
  it('reports a path it cannot even examine, and acts on nothing', () => {
    const tree = makeTree();
    const locked = join(tree.dir, 'locked');
    mkdirSync(locked);
    copyFileSync(tree.bundle, join(locked, 'zendesk.mcpb'));
    chmodSync(locked, 0o000);
    try {
      const run = runAudit(tree, ['locked/zendesk.mcpb']);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('cannot be examined: EACCES');
      expect(run.stderr).not.toContain('CONTAMINATED');
      expect(run.stderr).not.toMatch(/^\s+at .*\(node:/m);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

// =============================================================================================
// Scenario (#105): what is under the publishable name decides whether it can be audited at all,
// and that question is settled before anything opens it.
// =============================================================================================
describe('the publishable name has to hold a packed bundle', () => {
  // A FIFO hung the release gate for ever: readFileSync blocks in open(2) while nobody writes and
  // this path has no timeout. Measured in #105, aborted after 6 s with no output at all. The
  // spawn below carries a timeout so that a regression is a RED test and not a hung suite.
  it('refuses a FIFO within a bounded time instead of blocking in open(2)', () => {
    const tree = makeTree();
    rmSync(tree.bundle);
    execFileSync('mkfifo', [tree.bundle]);
    const run = spawnSync('node', [join(tree.dir, 'scripts', 'audit-bundle.mjs'), 'zendesk.mcpb'], {
      encoding: 'utf8',
      cwd: tree.dir,
      timeout: 20_000,
    });
    expect(run.signal, 'the audit was still running when the timeout fired').toBe(null);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('is a FIFO, not a packed bundle');
    expect(existsSync(tree.bundle)).toBe(true);
  });

  // `node scripts/audit-bundle.mjs ./some-directory` moved the WHOLE DIRECTORY to .REJECTED and
  // called it contaminated.
  it('refuses a directory and never moves it', () => {
    const tree = makeTree();
    const dir = join(tree.dir, 'a-directory');
    mkdirSync(dir);
    writeFileSync(join(dir, 'someone-elses-file'), 'not a bundle');
    const run = runAudit(tree, ['a-directory']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('is a directory, not a packed bundle');
    expect(existsSync(`${dir}.REJECTED`)).toBe(false);
    expect(existsSync(join(dir, 'someone-elses-file'))).toBe(true);
  });

  it('refuses a character device, naming what it found', () => {
    const run = runAudit(makeTree(), ['/dev/null']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('is a character device, not a packed bundle');
  });

  it('refuses a symlink that points at nothing', () => {
    const tree = makeTree();
    rmSync(tree.bundle);
    symlinkSync(join(tree.dir, 'gone.mcpb'), tree.bundle);
    const run = runAudit(tree);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('is a symlink pointing at nothing');
  });

  // `renameSync` on a link moves the LINK. The target kept the name it was reachable under, so
  // "it cannot be uploaded by name" held for the link only.
  it('quarantines the target of a symlink, not only the link', () => {
    const tree = makeTree({ entries: [...clean(), { name: 'tokens.enc', data: 'x' }] });
    const real = join(tree.dir, 'real-bundle.mcpb');
    copyFileSync(tree.bundle, real);
    rmSync(tree.bundle);
    symlinkSync(real, tree.bundle);
    const run = runAudit(tree);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('CONTAMINATED');
    expect(existsSync(real), 'the target kept its own uploadable name').toBe(false);
    expect(existsSync(`${tree.bundle}.REJECTED.target`)).toBe(true);
    // `lstat`, not `existsSync`: the quarantined LINK now dangles, which is the whole point —
    // existsSync follows it and would report the name as absent.
    expect(lstatSync(`${tree.bundle}.REJECTED`, { throwIfNoEntry: false })?.isSymbolicLink()).toBe(true);
    // And the publishable name resolves to nothing at all any more.
    expect(existsSync(tree.bundle)).toBe(false);
  });
});

// =============================================================================================
// Scenario (#105): the quarantine is evidence, and the search for a free name is bounded.
// =============================================================================================
describe('the quarantine keeps what the run before it found', () => {
  // Measured over two failing runs: run 2 overwrote run 1's .REJECTED and the tokens.enc inside it
  // was gone — three lines under a comment promising the evidence would survive.
  it('does not overwrite the previous .REJECTED', () => {
    const first = makeTree({ entries: [...clean(), { name: 'tokens.enc', data: 'first run' }] });
    expect(runAudit(first).status).toBe(1);
    const kept = readFileSync(`${first.bundle}.REJECTED`);

    writeFileSync(first.bundle, zip([...clean(), { name: 'tokens.enc', data: 'second run' }]));
    expect(runAudit(first).status).toBe(1);
    expect(readFileSync(`${first.bundle}.REJECTED`).equals(kept), 'run 1 evidence was overwritten').toBe(true);
    expect(existsSync(`${first.bundle}.REJECTED.1`)).toBe(true);
  });

  // The bound, named rather than discovered: round 4 of PR #102's review measured an unbounded
  // free-name search emit 67 MB of stderr and 90,235 lines in under 20 seconds, with the
  // contaminated bundle never quarantined — in CI that hangs the job.
  it('gives up after a bounded number of slots instead of searching forever', () => {
    const tree = makeTree({ entries: [...clean(), { name: 'tokens.enc', data: 'x' }] });
    writeFileSync(`${tree.bundle}.REJECTED`, 'taken');
    for (let n = 1; n <= 100; n += 1) writeFileSync(`${tree.bundle}.REJECTED.${n}`, 'taken');
    const run = spawnSync('node', [join(tree.dir, 'scripts', 'audit-bundle.mjs'), 'zendesk.mcpb'], {
      encoding: 'utf8',
      cwd: tree.dir,
      timeout: 20_000,
    });
    expect(run.signal).toBe(null);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('quarantine names next to zendesk.mcpb are taken');
    expect(run.stderr).toContain('DELETE IT BY HAND');
    expect(run.stderr.split('\n').length, 'the refusal printed a flood').toBeLessThan(60);
    // Nothing was moved and nothing was overwritten, and the operator has been told so.
    expect(existsSync(tree.bundle)).toBe(true);
    expect(readFileSync(`${tree.bundle}.REJECTED`, 'utf8')).toBe('taken');
  });
});

// =============================================================================================
// Scenario (#105): a relative argument belongs to the caller, and a declared entry bigger than a
// JavaScript string is a refusal rather than a stack trace.
// =============================================================================================
describe('the caller names the bundle', () => {
  // The artifact slot is the script tree's, because the version is. It used to be the caller's
  // directory with this tree's version number, so auditing a downloaded bundle deleted — and on a
  // pass overwrote — the operator's own release of that number, `.sha256` included.
  it('never touches an artifact in the caller\'s directory', () => {
    const tree = makeTree();
    const elsewhere = mkdtempSync(join(tmpdir(), 'audit-foreign-'));
    temps.push(elsewhere);
    copyFileSync(tree.bundle, join(elsewhere, 'zendesk.mcpb'));
    // The operator's own release of the version THIS tree declares, sitting where they put it.
    const theirs = join(elsewhere, 'zendesk-1.0.0.mcpb');
    writeFileSync(theirs, 'the operator released this');
    writeFileSync(`${theirs}.sha256`, 'and this is its checksum');

    // And the operator's release of that same number inside THIS tree, which is where the slot is.
    writeFileSync(tree.artifact, 'the release this tree published');
    writeFileSync(tree.checksum, 'and the checksum of that');

    const run = runAudit(tree, ['./zendesk.mcpb'], elsewhere);
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(theirs, 'utf8')).toBe('the operator released this');
    expect(readFileSync(`${theirs}.sha256`, 'utf8')).toBe('and this is its checksum');
    // NEITHER DIRECTORY. Moving the slot into `root` moved the destruction with it rather than
    // removing it: a PASSING audit of a downloaded bundle overwrote this tree's published release
    // of that version and rewrote its checksum to match a file that came from somewhere else.
    // A foreign bundle is audited and reported on; it does not get to claim this tree's name.
    expect(readFileSync(tree.artifact, 'utf8')).toBe('the release this tree published');
    expect(readFileSync(tree.checksum, 'utf8')).toBe('and the checksum of that');
    expect(run.stdout).toContain('No artifact was written');
    expect(run.stdout).toContain("is not this tree's own bundle");
  });

  // `root` is resolved through symlinks by node; the caller's cwd is whatever they typed. On macOS
  // /tmp is a symlink to /private/tmp, so a string compare of the two would have called this
  // tree's OWN bundle foreign and silently stopped writing artifacts.
  it('recognises its own bundle through a symlinked path', () => {
    const tree = makeTree();
    const link = join(mkdtempSync(join(tmpdir(), 'audit-link-')), 'tree');
    temps.push(dirname(link));
    symlinkSync(tree.dir, link);
    const run = runAudit(tree, [join(link, 'zendesk.mcpb')]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).not.toContain('No artifact was written');
    expect(existsSync(tree.artifact)).toBe(true);
  });

  it('resolves a relative argument against the caller cwd, not the script tree', () => {
    const tree = makeTree();
    const elsewhere = mkdtempSync(join(tmpdir(), 'audit-cwd-'));
    temps.push(elsewhere);
    copyFileSync(tree.bundle, join(elsewhere, 'moved.mcpb'));
    // From `elsewhere`, `./moved.mcpb` is the file there — and `zendesk.mcpb`, which exists in the
    // script's tree and used to be what this resolved to, is not there at all.
    expect(runAudit(tree, ['./moved.mcpb'], elsewhere).status).toBe(0);
    const stray = runAudit(tree, ['./zendesk.mcpb'], elsewhere);
    expect(stray.status).toBe(2);
    expect(stray.stderr).toContain(join(elsewhere, 'zendesk.mcpb'));
  });
});

// =============================================================================================
// Mutation coverage. Three times in the executor-guard ticket a negative test passed for a reason
// other than the rule it claimed to pin. So the property is asserted directly: ablate one rule and
// a fixture must change its verdict. A rule no fixture distinguishes fails HERE.
// =============================================================================================
describe('mutation coverage — every rule is pinned by a fixture that notices its absence', () => {
  const ANCHOR = 'const EOCD_SIG = 0x06054b50;';
  /** Removes one named rule from one of the three rule lists. */
  const drop = (list: string, rule: string): Array<[string, string]> => [
    [
      ANCHOR,
      // A typo would make findIndex return -1 and splice drop the LAST rule instead — a mutant
      // that tests something nobody asked about, and passes.
      `{ const i = ${list}.findIndex((r) => r.rule === '${rule}');\n` +
        `  if (i < 0) throw new Error('no such rule: ${rule}');\n` +
        `  ${list}.splice(i, 1); }\n${ANCHOR}`,
    ],
  ];

  const CASES: Array<{
    rule: string;
    mutate: Array<[string, string]>;
    entries?: ZipEntry[];
    raw?: Buffer;
    zipOpts?: { declaredCount?: number };
    tree?: Parameters<typeof makeTree>[0];
    args?: string[];
    seed?: (t: Tree) => void;
    baseline: (r: Run, t: Tree) => void;
    ablated: (r: Run, t: Tree) => void;
  }> = [
    // ---- #105. Each one of these distinguishes a rule this ticket added; the three that cannot
    // ride this harness (a cwd other than the tree, a spawn timeout, a 512 MiB fixture) have their
    // own ablation beneath it.
    {
      rule: 'a tree fault is not a bundle verdict and moves nothing',
      mutate: [
        [
          "const manifest = readJson(join(root, 'manifest.json'), 'manifest.json', treeFaults);",
          "const manifest = readJson(join(root, 'manifest.json'), 'manifest.json', problems);",
        ],
      ],
      seed: (t) => writeFileSync(join(t.dir, 'manifest.json'), '{ not json'),
      baseline: (r: Run, t: Tree) => {
        expect(r.status).toBe(2);
        expect(existsSync(t.bundle)).toBe(true);
      },
      ablated: (_r: Run, t: Tree) => expect(existsSync(t.bundle)).toBe(false),
    },
    {
      // The exact route by which a broken manifest.json destroyed a provably clean bundle: version
      // fell to null, every bundle disagreed with null, and the disagreement was filed as
      // contamination.
      rule: 'the bundled-version comparison needs a version to compare with',
      mutate: [['    if (version !== null && bundledVersion !== version) {', '    if (bundledVersion !== version) {']],
      // BOTH manifests, because `version` falls back from manifest.json to package.json; it is
      // only null when neither can be read, and null is what every bundle disagreed with. This is
      // the pair #105 measured: readable manifests gave exit 0 and an artifact, both corrupt made
      // the same byte-identical bundle disappear.
      seed: (t) => {
        writeFileSync(join(t.dir, 'manifest.json'), '{ not json');
        writeFileSync(join(t.dir, 'package.json'), '{ not json');
      },
      baseline: (r: Run, t: Tree) => {
        expect(r.stderr).not.toContain('CONTAMINATED');
        expect(existsSync(t.bundle)).toBe(true);
      },
      ablated: (r: Run, t: Tree) => {
        // The clean bundle is moved and announced as a refusal, on a run where the only thing
        // wrong is that this checkout has no version to compare against.
        expect(r.stderr).toContain('version mismatch');
        expect(r.stderr).toContain('has been moved to');
        expect(existsSync(t.bundle)).toBe(false);
      },
    },
    {
      rule: 'the shape under the publishable name is what names the refusal',
      mutate: [['const shape = bundleShape(bundlePath);', 'const shape = {};']],
      args: ['a-directory'],
      seed: (t) => mkdirSync(join(t.dir, 'a-directory')),
      baseline: (r: Run) => expect(r.stderr).toContain('is a directory, not a packed bundle'),
      ablated: (r: Run) => {
        expect(r.stderr).not.toContain('not a packed bundle');
        expect(r.stderr).toContain('could not be read: EISDIR');
      },
    },
    {
      rule: 'the quarantine takes a free slot instead of overwriting the one before it',
      mutate: [
        ['  const slot = freeQuarantineSlot(bundlePath);', '  const slot = { name: `${bundlePath}.REJECTED` };'],
      ],
      entries: [...clean(), { name: 'tokens.enc', data: 'x' }],
      seed: (t) => writeFileSync(`${t.bundle}.REJECTED`, 'run one evidence'),
      baseline: (_r: Run, t: Tree) => {
        expect(readFileSync(`${t.bundle}.REJECTED`, 'utf8')).toBe('run one evidence');
        expect(existsSync(`${t.bundle}.REJECTED.1`)).toBe(true);
      },
      ablated: (_r: Run, t: Tree) =>
        expect(readFileSync(`${t.bundle}.REJECTED`, 'utf8')).not.toBe('run one evidence'),
    },
    {
      rule: 'the quarantine reaches the target of a symlink, not only the link',
      mutate: [
        ['      if (shape.symlink) renameSync(realpathSync(bundlePath), `${slot.name}.target`);', '      void realpathSync;'],
      ],
      entries: [...clean(), { name: 'tokens.enc', data: 'x' }],
      seed: (t) => {
        const real = join(t.dir, 'real-bundle.mcpb');
        copyFileSync(t.bundle, real);
        rmSync(t.bundle);
        symlinkSync(real, t.bundle);
      },
      baseline: (_r: Run, t: Tree) => expect(existsSync(join(t.dir, 'real-bundle.mcpb'))).toBe(false),
      ablated: (_r: Run, t: Tree) => expect(existsSync(join(t.dir, 'real-bundle.mcpb'))).toBe(true),
    },
    {
      rule: 'the allowlist default is refusal',
      mutate: [
        [
          'const allow = unsafe ? null : ALLOWED.find((rule) => rule.match(path));',
          "const allow = unsafe ? null : (ALLOWED.find((rule) => rule.match(path)) ?? { rule: 'anything-goes' });",
        ],
      ],
      entries: [...clean(), { name: 'vendor/thing.bin', data: 'harmless\n' }],
      baseline: (r) => expect(r.status).not.toBe(0),
      ablated: (r) => expect(r.status).toBe(0),
    },
    {
      rule: 'the forbidden list refuses what the allowlist would admit',
      mutate: [['function forbiddenBy(path) {', 'function forbiddenBy(path) {\n  return null;']],
      // Allowlisted by `runtime-dependencies`, so only the forbidden list can refuse it.
      entries: [...clean(), { name: 'node_modules/dep/.npmrc', data: 'harmless\n' }],
      baseline: (r) => expect(r.status).not.toBe(0),
      ablated: (r) => expect(r.status).toBe(0),
    },
    {
      rule: 'the content scan runs at all',
      mutate: [['  for (const { rule, re, skip } of CREDENTIAL_PATTERNS) {', '  for (const { rule, re, skip } of []) {']],
      entries: [
        ...clean().filter((e) => e.name !== 'README.md'),
        { name: 'README.md', data: PLANTED },
      ],
      baseline: (r) => expect(r.status).not.toBe(0),
      ablated: (r) => expect(r.status).toBe(0),
    },
    {
      rule: 'the content scan walks past a carved-out first match',
      mutate: [
        [
          'for (let hit = scan.exec(text); hit !== null; hit = scan.exec(text)) {',
          'for (let hit = scan.exec(text); hit !== null; hit = null) {',
        ],
      ],
      entries: [
        ...clean(),
        {
          name: 'dist/config.js',
          data: `const a = { CLIENT_SECRET: 'oauth_client_secret' };\nconst b = { api_key: "${SENTINEL_TOKEN}" };\n`,
        },
      ],
      baseline: (r) => expect(r.status).not.toBe(0),
      ablated: (r) => expect(r.status).toBe(0),
    },
    {
      rule: 'the identifier carve-out exists (no standing false positive)',
      mutate: [['      if (skip?.(hit)) continue;', '      if (false) continue;']],
      entries: [
        ...clean(),
        { name: 'dist/config.js', data: "const f = { CLIENT_SECRET: 'oauth_client_secret' };\n" },
      ],
      baseline: (r) => expect(r.status).toBe(0),
      ablated: (r) => expect(r.status).not.toBe(0),
    },
    {
      // Skipping a binary would switch all seven credential rules off for that entry in silence,
      // which is how `dist/tokens.enc.js` cleared both the allowlist (on its extension) and the
      // scan (on the NUL byte). Refusing is the rule; the ablation is the old skip.
      rule: 'binary content outside node_modules is refused, not skipped',
      mutate: [
        [
          '  if (content.subarray(0, 8192).includes(0)) {\n    problems.push(`binary content where only text belongs, and the credential scan cannot read it: ${path}`);\n    continue;\n  }',
          '  if (content.subarray(0, 8192).includes(0)) continue;',
        ],
      ],
      entries: [
        ...clean(),
        { name: 'dist/blob.js', data: Buffer.concat([Buffer.from(PLANTED), Buffer.from([0x00])]) },
      ],
      baseline: (r) => expect(r.status).not.toBe(0),
      ablated: (r) => expect(r.status).toBe(0),
    },
    {
      rule: 'node_modules is excluded from the content scan',
      mutate: [["  if (path.startsWith('node_modules/')) continue;", '  if (false) continue;']],
      entries: [
        ...clean().filter((e) => !e.name.startsWith('node_modules/')),
        { name: 'node_modules/dep/fixture.js', data: PLANTED },
      ],
      baseline: (r) => expect(r.status).toBe(0),
      ablated: (r) => expect(r.status).not.toBe(0),
    },
    {
      rule: 'an empty archive is refused',
      mutate: [['if (readable && entries.length === 0) problems.push(', 'if (false) problems.push(']],
      entries: [],
      baseline: (r) => expect(r.status).not.toBe(0),
      ablated: (r) => expect(r.status).toBe(0),
    },
    {
      rule: 'the bundled manifest must agree with the tree',
      mutate: [['    if (version !== null && bundledVersion !== version) {', '    if (false) {']],
      entries: clean('0.9.0'),
      baseline: (r) => expect(r.status).not.toBe(0),
      ablated: (r) => expect(r.status).toBe(0),
    },
    {
      rule: 'the requested tag must agree with the tree',
      mutate: [['if (expectedVersion !== null && version !== expectedVersion) {', 'if (false) {']],
      args: ['zendesk.mcpb', '--expect-version', '9.9.9'],
      baseline: (r) => expect(r.status).not.toBe(0),
      ablated: (r) => expect(r.status).toBe(0),
    },
    {
      rule: 'a refusal clears an artifact left by an earlier run',
      mutate: [
        ['      rmSync(stale, { force: true });', '      void stale;'],
      ],
      entries: [...clean(), { name: 'tokens.enc', data: 'x' }],
      seed: (t) => writeFileSync(t.artifact, 'stale bundle from the run before'),
      baseline: (r, t) => expect(existsSync(t.artifact)).toBe(false),
      ablated: (r, t) => expect(existsSync(t.artifact)).toBe(true),
    },
    // ---- readArchive / readEntry. Both BLOCKERs lived here and no fixture distinguished them.
    //
    // Five of the cases below discriminate on the reported CAUSE rather than on the exit status,
    // and that is a finding in itself: the reader's checks overlap, so removing one leaves the
    // next one refusing the archive anyway (measured — a removed data-descriptor check is caught
    // by the local-header tiling, a removed encryption check by the credential scan). Exit status
    // therefore cannot pin them. What can is which layer speaks, so that is what is asserted; the
    // same discipline as the settler cases in executor-safety-guard.test.ts.
    {
      rule: 'the central directory is parsed by size, not by the declared count',
      mutate: [
        ['  let at = cdStart;\n  while (at < cdEnd) {', '  let at = cdStart;\n  while (at < cdEnd && entries.length < declared) {'],
        // Without this second edit the count check below would catch the mutant for the wrong
        // reason; ablating both isolates the parse strategy itself.
        ['  if (entries.length !== declared) {', '  if (false) {'],
      ],
      entries: [...clean(), { name: 'secret.txt', data: PLANTED }],
      zipOpts: { declaredCount: 6 },
      baseline: (r: Run) => expect(r.stderr).toContain('claims 6 entries, the directory holds 7'),
      ablated: (r: Run) => {
        expect(r.stderr).not.toContain('claims 6 entries');
        expect(r.stderr).toContain('does not end on a record boundary'); // the next layer
      },
    },
    {
      rule: 'a declared count that disagrees with the records found is a refusal',
      mutate: [['  if (entries.length !== declared) {', '  if (false) {']],
      entries: clean(),
      zipOpts: { declaredCount: 5 },
      // Nothing else objects here: the directory is well-formed, only its count is a lie.
      baseline: (r: Run) => expect(r.status).not.toBe(0),
      ablated: (r: Run) => expect(r.status).toBe(0),
    },
    {
      rule: 'an entry present only in the local headers is a refusal',
      mutate: [
        [
          "    if (!entry) throw new Error(`${localName}: present in the local headers but absent from the central directory`);",
          '    if (!entry) { pos += 30 + nameLength + buf.readUInt16LE(pos + 28); continue; }',
        ],
      ],
      entries: [...clean(), { name: 'tokens.enc', data: '', localOnly: true }],
      baseline: (r: Run) => expect(r.status).not.toBe(0),
      ablated: (r: Run) => expect(r.status).toBe(0),
    },
    {
      rule: 'a local name that disagrees with the directory name is a refusal',
      mutate: [['    if (localName !== entry.name) {', '    if (false) {']],
      entries: [...clean(), { name: 'tokens.enc', data: 'x', cdName: 'dist/ok.js' }],
      baseline: (r: Run) => expect(r.status).not.toBe(0),
      ablated: (r: Run) => expect(r.status).toBe(0),
    },
    {
      rule: 'a data descriptor is a refusal, because its declared size may be zero',
      mutate: [['    if (flags & FLAG_DATA_DESCRIPTOR) {', '    if (false) {']],
      entries: [
        ...clean().filter((e) => e.name !== 'README.md'),
        { name: 'README.md', data: PLANTED, flags: 0x08, descriptor: true, cdCompressedSize: 0, cdSize: 0 },
      ],
      baseline: (r: Run) => expect(r.stderr).toContain('uses a data descriptor'),
      ablated: (r: Run) => {
        expect(r.stderr).not.toContain('data descriptor');
        // The tiling check. NOTE what this leans on: the fixture writes a real descriptor with
        // zeroed local sizes, so with the flag check gone the walk lands mid-data. If zip() ever
        // stops zeroing those sizes the archive tiles again and this goes red for a reason that
        // has nothing to do with the reader.
        expect(r.stderr).toContain('expected a local file header');
      },
    },
    {
      rule: 'an encrypted entry is a refusal',
      mutate: [['    if (flags & FLAG_ENCRYPTED) throw', '    if (false) throw']],
      entries: [
        ...clean().filter((e) => e.name !== 'README.md'),
        { name: 'README.md', data: PLANTED, flags: 0x01 },
      ],
      baseline: (r: Run) => expect(r.stderr).toContain('is encrypted and cannot be inspected'),
      // Without it the auditor reads the entry as plaintext. Here the credential scan happens to
      // catch the payload; a forbidden PATH in an encrypted entry would not be so lucky, which is
      // why the refusal sits at the reader and not downstream of it.
      ablated: (r: Run) => {
        expect(r.stderr).not.toContain('encrypted');
        expect(r.stderr).toContain('[credential-assignment]');
      },
    },
    {
      rule: 'a byte count that disagrees with the declaration is a refusal',
      mutate: [['  if (content.length !== entry.size) {', '  if (false) {']],
      entries: [
        ...clean().filter((e) => e.name !== 'README.md'),
        { name: 'README.md', data: PLANTED, cdSize: 4 },
      ],
      baseline: (r: Run) => expect(r.stderr).toContain('where the directory declares 4'),
      ablated: (r: Run) => {
        expect(r.stderr).not.toContain('where the directory declares');
        expect(r.stderr).toContain('[credential-assignment]');
      },
    },
    {
      // The exact line that was there: a zero-byte marker skipped unsafePath, the forbidden list
      // and the allowlist in one go, and appeared in neither the accepted nor the refused count.
      rule: 'a directory marker is not waved past the path rules',
      mutate: [
        [
          '  const unsafe = unsafePath(path);',
          "  if (path.endsWith('/') && entry.size === 0) continue;\n  const unsafe = unsafePath(path);",
        ],
      ],
      entries: [
        ...clean(),
        { name: '.zendesk-plugin-data/', data: '' },
        { name: '../../../../tmp/pwned/', data: '' },
      ],
      baseline: (r: Run) => expect(r.status).not.toBe(0),
      ablated: (r: Run) => {
        expect(r.status).toBe(0);
        // The shape of the old defect: the archive passes AND the count silently omits them.
        expect(r.stdout).toContain('Accepted 6 paths');
      },
    },
    {
      rule: 'a marker inside an allowed tree is allowed by a named rule',
      mutate: drop('ALLOWED', 'directory-marker'),
      entries: [...clean(), { name: 'dist/auth/', data: '' }],
      baseline: (r: Run) => expect(r.status).toBe(0),
      ablated: (r: Run) => expect(r.status).not.toBe(0),
    },
    {
      rule: 'a marker carrying a payload is a refusal',
      mutate: [
        [
          '    if (entry.size !== 0) problems.push(`directory marker carrying ${entry.size} bytes of content: ${path}`);',
          '    void entry;',
        ],
      ],
      entries: [...clean(), { name: 'dist/auth/', data: PLANTED }],
      baseline: (r: Run) => expect(r.status).not.toBe(0),
      ablated: (r: Run) => expect(r.status).toBe(0),
    },
    // Six branches that had no fixture at all. Only the directory-signature one can be pinned by
    // exit status; the rest are caught by a neighbouring fail-closed check once ablated, so what
    // is asserted is which layer speaks — the reason is recorded above.
    {
      rule: 'a ZIP64 sentinel in the EOCD is a refusal',
      mutate: [
        [
          '  if (declared === ZIP64_U16 || cdSize === ZIP64_U32 || cdStart === ZIP64_U32) {',
          '  if (false) {',
        ],
      ],
      raw: (() => {
        const buf = zip(clean());
        buf.writeUInt32LE(0xffffffff, buf.length - 22 + 16);
        return buf;
      })(),
      baseline: (r: Run) => expect(r.stderr).toContain('ZIP64 archive'),
      ablated: (r: Run) => {
        expect(r.stderr).not.toContain('ZIP64 archive');
        expect(r.stderr).toContain('runs past the end of the file');
      },
    },
    {
      rule: 'a directory reaching past the end of the file is a refusal',
      mutate: [['  if (cdEnd > buf.length || cdEnd > eocd) throw', '  if (false) throw']],
      raw: (() => {
        const buf = zip(clean());
        buf.writeUInt32LE(buf.readUInt32LE(buf.length - 22 + 12) + 400, buf.length - 22 + 12);
        return buf;
      })(),
      baseline: (r: Run) => expect(r.stderr).toContain('runs past the end of the file'),
      ablated: (r: Run) => {
        expect(r.stderr).not.toContain('runs past the end of the file');
        expect(r.stderr).toContain('is malformed');
      },
    },
    {
      // The only one of the six that is load-bearing on its own: with the signature check gone the
      // archive PASSES, because the rest of the junked record still parses as plausible fields.
      rule: 'a directory record must carry the directory signature',
      mutate: [
        ['    if (at + 46 > cdEnd || buf.readUInt32LE(at) !== CENTRAL_SIG) {', '    if (false) {'],
      ],
      raw: (() => {
        const buf = zip(clean());
        buf.writeUInt32LE(0xdeadbeef, buf.readUInt32LE(buf.length - 22 + 16));
        return buf;
      })(),
      baseline: (r: Run) => expect(r.status).not.toBe(0),
      ablated: (r: Run) => expect(r.status).toBe(0),
    },
    {
      rule: 'a ZIP64 sentinel on an entry is a refusal',
      mutate: [
        [
          '    if (entry.compressedSize === ZIP64_U32 || entry.size === ZIP64_U32 || entry.local === ZIP64_U32) {',
          '    if (false) {',
        ],
      ],
      entries: [...clean(), { name: 'dist/x.js', data: 'export {};\n', cdCompressedSize: 0xffffffff }],
      baseline: (r: Run) => expect(r.stderr).toContain('ZIP64 sentinel in the central directory'),
      ablated: (r: Run) => {
        expect(r.stderr).not.toContain('ZIP64 sentinel');
        expect(r.stderr).toContain('the local headers do not reach the central directory');
      },
    },
    {
      rule: 'a ZIP64 sentinel on an entry offset is a refusal too',
      mutate: [
        [
          '    if (entry.compressedSize === ZIP64_U32 || entry.size === ZIP64_U32 || entry.local === ZIP64_U32) {',
          '    if (false) {',
        ],
      ],
      entries: [...clean(), { name: 'dist/x.js', data: 'export {};\n', cdLocalOffset: 0xffffffff }],
      baseline: (r: Run) => expect(r.stderr).toContain('ZIP64 sentinel in the central directory'),
      ablated: (r: Run) => {
        expect(r.stderr).not.toContain('ZIP64 sentinel');
        expect(r.stderr).toContain('present in the local headers but absent from the central directory');
      },
    },
    {
      rule: 'an undecodable compression method is a refusal, not a guess',
      mutate: [['  if (entry.method !== 0 && entry.method !== 8) {', '  if (false) {']],
      entries: [...clean(), { name: 'dist/x.js', data: 'export {};\n', method: 12 }],
      baseline: (r: Run) => expect(r.stderr).toContain('unsupported ZIP compression method 12'),
      // Without it the auditor hands BZIP2 bytes to inflate and reports a zlib code instead of the
      // cause. Fail-closed either way, but the operator can no longer read what happened.
      ablated: (r: Run) => {
        expect(r.stderr).not.toContain('unsupported ZIP compression method');
        expect(r.stderr).toContain('Z_DATA_ERROR');
      },
    },
    {
      rule: 'a directory record with no reachable local header is a refusal',
      mutate: [
        [
          '    if (entry.dataAt === undefined) throw new Error(`${entry.name}: its local file header is unreachable`);',
          '    void entry;',
        ],
      ],
      entries: [
        ...clean(),
        { name: 'dist/ok.js', data: 'export {};\n' },
        { name: 'dist/ok.js', data: 'export {};\n', cdOnly: true, cdLocalOffsetOf: 'dist/ok.js' },
      ],
      baseline: (r: Run) => expect(r.stderr).toContain('its local file header is unreachable'),
      // Without it the entry is read with dataAt undefined, which slices from byte 0 — the auditor
      // would be scanning a different entry's bytes and calling the result this entry's.
      ablated: (r: Run) => expect(r.stderr).not.toContain('its local file header is unreachable'),
    },
    {
      rule: 'an over-long expansion is reported as a rule, not as a zlib code',
      mutate: [
        [
          "      throw new Error(`${entry.name}: expands past the ${entry.size} bytes it declares (${error.code ?? error.message})`);",
          '      throw error;',
        ],
      ],
      entries: [...clean(), { name: 'dist/big.js', data: '\n'.repeat(200_000), method: 8, cdSize: 16 }],
      baseline: (r: Run) => expect(r.stderr).toContain('expands past the 16 bytes it declares'),
      ablated: (r: Run) => expect(r.stderr).not.toContain('expands past'),
    },
    {
      rule: 'a multi-part archive is a refusal',
      mutate: [["  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {", '  if (false) {']],
      raw: (() => {
        const buf = zip(clean());
        buf.writeUInt16LE(1, buf.length - 22 + 4);
        return buf;
      })(),
      baseline: (r: Run) => expect(r.status).not.toBe(0),
      ablated: (r: Run) => expect(r.status).toBe(0),
    },
    {
      rule: 'a control character in an entry name is a refusal',
      mutate: [["  if (/[\\u0000-\\u001f\\u007f]/.test(path)) return 'a control character in the name';", '']],
      entries: [...clean(), { name: 'dist/a\u0000b.js', data: 'export {};\n' }],
      baseline: (r: Run) => expect(r.status).not.toBe(0),
      ablated: (r: Run) => expect(r.status).toBe(0),
    },
    {
      rule: 'an unsafe entry name is a refusal',
      mutate: [['function unsafePath(path) {', 'function unsafePath(path) {\n  return null;']],
      entries: [...clean(), { name: 'dist/../../../../tmp/pwn.js', data: 'export {};\n' }],
      baseline: (r: Run) => expect(r.status).not.toBe(0),
      ablated: (r: Run) => expect(r.status).toBe(0),
    },
    {
      rule: 'the refusal quarantines the unaudited bundle under a name nobody uploads',
      mutate: [['      renameSync(bundlePath, slot.name);', '      void slot;']],
      entries: [...clean(), { name: 'tokens.enc', data: 'x' }],
      baseline: (_r: Run, t: Tree) => expect(existsSync(t.bundle)).toBe(false),
      ablated: (_r: Run, t: Tree) => expect(existsSync(t.bundle)).toBe(true),
    },
    // Each forbidden rule, one at a time: without it, that path loses its named finding.
    ...(
      [
        ['encrypted-token-store', 'node_modules/dep/store.enc'],
        ['dotenv-file', 'node_modules/dep/.env.local'],
        ['private-key-material', 'node_modules/dep/fixtures/server.pem'],
        ['npm-credentials-file', 'node_modules/dep/.npmrc'],
        ['runtime-data-directory', 'node_modules/dep/.zendesk-plugin-data/x.json'],
        ['user-data-directory', 'node_modules/dep/users/1.json'],
        ['issued-credential-directory', 'node_modules/dep/issued/1.json'],
        ['git-directory', 'node_modules/dep/.git/config'],
        ['coverage-output', 'node_modules/dep/coverage/lcov.info'],
      ] as Array<[string, string]>
    ).map(([rule, path]) => ({
      // Every path here is allowlisted by `runtime-dependencies`, so the ONLY thing that can refuse
      // it is the forbidden rule under test. Exit status therefore discriminates on its own.
      rule: `forbidden rule ${rule}`,
      mutate: drop('FORBIDDEN', rule),
      entries: [...clean(), { name: path, data: 'harmless\n' }],
      baseline: (r: Run) => expect(r.status).not.toBe(0),
      ablated: (r: Run) => expect(r.status).toBe(0),
    })),
    // Each credential rule, one at a time.
    ...CREDENTIAL_FIXTURES.map(([rule, body]) => ({
      rule: `credential rule ${rule}`,
      mutate: drop('CREDENTIAL_PATTERNS', rule),
      entries: [...clean().filter((e) => e.name !== 'README.md'), { name: 'README.md', data: body }],
      baseline: (r: Run) => expect(r.status).not.toBe(0),
      ablated: (r: Run) => expect(r.status).toBe(0),
    })),
    // Each allowlist rule, one at a time: without it, the legitimate path it admits is refused —
    // which is how each rule proves it is load-bearing rather than decorative.
    ...(
      ['manifest', 'package-metadata', 'license', 'readme', 'compiled-server', 'runtime-dependencies'] as string[]
    ).map((rule) => ({
      rule: `allowlist rule ${rule}`,
      mutate: drop('ALLOWED', rule),
      baseline: (r: Run) => expect(r.status).toBe(0),
      ablated: (r: Run) => expect(r.status).not.toBe(0),
    })),
  ];

  // ---- The three #105 rules the harness above cannot carry, each ablated by hand.

  // A CWD OTHER THAN THE TREE. The harness always stands in the fixture, which is exactly the
  // accident that hid this defect: `resolve(root, …)` happened to give the fixture's own bundle.
  it('ablated: a relative argument resolved against the script tree misses the caller\'s file', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'audit-cwd-ablation-'));
    temps.push(elsewhere);
    const mutate: Array<[string, string]> = [
      [
        'const bundlePath = positional[0] === undefined ? ownBundlePath : resolve(positional[0]);',
        "const bundlePath = resolve(root, positional[0] ?? 'zendesk.mcpb');",
      ],
    ];
    for (const [label, opts] of [
      ['baseline', {}],
      ['ablated', { mutate }],
    ] as const) {
      const tree = makeTree(opts);
      copyFileSync(tree.bundle, join(elsewhere, `${label}.mcpb`));
      const run = runAudit(tree, [`./${label}.mcpb`], elsewhere);
      if (label === 'baseline') expect(run.status, run.stderr).toBe(0);
      else expect(run.stderr).toContain(join(tree.dir, `${label}.mcpb`));
    }
  });

  // A SPAWN TIMEOUT, because the ablation of a bound does not terminate — that is the whole claim.
  // Round 4 of PR #102's review measured the unbounded version emitting 67 MB of stderr and 90,235
  // lines in under 20 seconds, and in CI it hangs the job. With a 15 s timeout the unbounded run is
  // KILLED (a signal, no exit code) and the bounded one answers in milliseconds.
  it('ablated: an unbounded free-name search never returns', () => {
    const entries = [...clean(), { name: 'tokens.enc', data: 'x' }];
    const mutate: Array<[string, string]> = [
      ['for (let n = 0; n <= QUARANTINE_SLOTS; n += 1) {', 'for (let n = 0; ; n += 1) {'],
      // Every candidate taken, without writing a hundred thousand files: the slot check is told
      // the name is always there. The LOOP is what is on trial, not the filesystem.
      ["return lstatSync(path, { throwIfNoEntry: false }) === undefined ? 'free' : 'taken';", "return 'taken';"],
    ];
    // The bounded side is measured by "gives up after a bounded number of slots" above, with the
    // same timeout and the same message; only the ablation belongs here.
    const unbounded = makeTree({ entries, mutate });
    const run = spawnSync('node', [join(unbounded.dir, 'scripts', 'audit-bundle.mjs'), 'zendesk.mcpb'], {
      encoding: 'utf8',
      cwd: unbounded.dir,
      timeout: 15_000,
    });
    expect(run.signal, 'the unbounded search returned on its own').not.toBe(null);
  }, 60_000);

  // A 512 MiB FIXTURE, built once and audited twice — this case carries #105 AC 7 whole, baseline
  // and ablation, rather than repeating the baseline as a behaviour case of its own.
  //
  // The threshold is node's: buffer.constants.MAX_STRING_LENGTH, 536 870 888 bytes on 64-bit. One
  // byte past it, `content.toString('utf8')` throws ERR_STRING_TOO_LONG, and that used to leave
  // the release gate as a stack trace where a verdict belongs. The fixture is CHEAP despite the
  // size: 512 MiB of one repeated non-NUL byte DEFLATEs to about 510 KB, so the archive on disk is
  // small. Measured on this host: 0.8 s to deflate, 0.3 s to inflate, ~1.9 GB peak RSS across the
  // two processes. The byte is 'a' and not 0, because a NUL in the first 8192 bytes is refused one
  // rule earlier and the case would pass for the wrong reason.
  it('ablated: an unguarded toString leaves the release gate as a stack trace', () => {
    const entries = [...clean(), { name: 'dist/huge.js', data: Buffer.allocUnsafe(constants.MAX_STRING_LENGTH + 1).fill(0x61), method: 8 }];
    const baselineTree = makeTree({ entries });
    const baseline = runAudit(baselineTree);
    expect(baseline.status, 'a refusal, so the bundle is quarantined like any other').toBe(1);
    expect(existsSync(`${baselineTree.bundle}.REJECTED`)).toBe(true);
    expect(baseline.stderr).toContain('entry too large for the credential scan to read as text, refused: dist/huge.js');
    expect(baseline.stderr).toContain('ERR_STRING_TOO_LONG');
    expect(baseline.stderr).not.toMatch(/^\s+at .*\(node:/m);

    const ablated = runAudit(
      makeTree({
        entries,
        mutate: [["    text = content.toString('utf8');", "    text = content.toString('utf8'); void 0;"], ['  } catch (error) {\n    problems.push(\n      `entry too large', '  } catch (error) {\n    throw error;\n    problems.push(\n      `entry too large']],
      }),
    );
    expect(ablated.stderr).toMatch(/ERR_STRING_TOO_LONG/);
    expect(ablated.stderr).toMatch(/^\s+at /m);
    expect(ablated.stderr).not.toContain('entry too large for the credential scan');
  }, 240_000);

  it.each(CASES)('$rule', ({ mutate, entries, raw, zipOpts, tree, args, seed, baseline, ablated }) => {
    const plain = makeTree({ ...tree, entries, raw, zipOpts });
    seed?.(plain);
    baseline(runAudit(plain, args), plain);
    const mutant = makeTree({ ...tree, entries, raw, zipOpts, mutate });
    seed?.(mutant);
    ablated(runAudit(mutant, args), mutant);
  });
});
