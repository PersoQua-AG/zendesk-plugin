import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

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
  const bundle = join(dir, 'zendesk.mcpb');
  writeFileSync(bundle, opts.raw ?? zip(opts.entries ?? clean(), opts.zipOpts));
  return {
    dir,
    bundle,
    artifact: join(dir, `zendesk-${version}.mcpb`),
    checksum: join(dir, `zendesk-${version}.mcpb.sha256`),
  };
}

function runAudit(tree: Tree, args: string[] = ['zendesk.mcpb']): Run {
  const run = spawnSync('node', [join(tree.dir, 'scripts', 'audit-bundle.mjs'), ...args], { encoding: 'utf8' });
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
    expect(run.stderr).not.toContain('at Object.');
  });

  it('refuses a file too small to be an archive', () => {
    const run = runAudit(makeTree({ raw: Buffer.from('PK') }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('smaller than an empty ZIP archive');
  });

  it('refuses a missing bundle, as a message and not a stack trace', () => {
    const run = runAudit(makeTree(), ['no-such-bundle.mcpb']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('could not be read as a bundle');
    expect(run.stderr).not.toContain('at Object.readFileSync');
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
  it('fails when manifest.json and package.json disagree, before producing anything', () => {
    const tree = makeTree({ manifestVersion: '1.0.0', packageVersion: '1.0.1' });
    const run = runAudit(tree);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('manifest.json says 1.0.0, package.json says 1.0.1');
    expect(existsSync(tree.artifact)).toBe(false);
  });

  it('fails when the bundled manifest disagrees with the tree', () => {
    const tree = makeTree({ entries: clean('0.9.0') });
    const run = runAudit(tree);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('the bundled manifest.json says 0.9.0, the tree declares 1.0.0');
    expect(existsSync(tree.artifact)).toBe(false);
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

  it('is stamped 1.0.1, with every other declaration held by the manifest validator', () => {
    // scripts/validate-manifests.mjs owns the fan-out across all seven hand-kept sites and is CI's
    // first step; tests/plugin/pack-script.test.ts drives it. Repeating it here would be a third
    // owner for one question.
    expect(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version).toBe('1.0.1');
    expect(pkg.version).toBe('1.0.1');
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
      rule: 'manifest.json and package.json must agree',
      mutate: [['if (pkg && manifest && pkg.version !== manifest.version) {', 'if (false) {']],
      tree: { manifestVersion: '1.0.0', packageVersion: '1.0.1' },
      baseline: (r) => expect(r.status).not.toBe(0),
      ablated: (r) => expect(r.status).toBe(0),
    },
    {
      rule: 'the bundled manifest must agree with the tree',
      mutate: [['    if (bundledVersion !== version) {', '    if (false) {']],
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
        [
          'if (artifactPath) for (const stale of [artifactPath, checksumPath]) rmSync(stale, { force: true });',
          '',
        ],
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
      mutate: [['      renameSync(bundlePath, quarantined);', '      void quarantined;']],
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

  it.each(CASES)('$rule', ({ mutate, entries, raw, zipOpts, tree, args, seed, baseline, ablated }) => {
    const plain = makeTree({ ...tree, entries, raw, zipOpts });
    seed?.(plain);
    baseline(runAudit(plain, args), plain);
    const mutant = makeTree({ ...tree, entries, raw, zipOpts, mutate });
    seed?.(mutant);
    ablated(runAudit(mutant, args), mutant);
  });
});
