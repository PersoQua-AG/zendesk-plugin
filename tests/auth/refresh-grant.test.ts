import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, renameSync, utimesSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { IdentityTokenStore } from '../../src/auth/identity-store.js';
import { IdentityAuthResolver } from '../../src/auth/identity-resolver.js';
import { IssuedTokenStore } from '../../src/auth/issued-token-store.js';
import { EncryptedFile } from '../../src/auth/encrypted-file.js';
import { RefreshTokenStore, RefreshTokenReplayError, RefreshInFlightError, type RefreshRecord, type ChainHead } from '../../src/auth/refresh-token-store.js';
import type { OpaqueRecord } from '../../src/auth/opaque-token-store.js';
import { ZendeskBridgeOAuthProvider } from '../../src/remote/bridge-oauth-provider.js';
import { CONNECTOR } from '../../src/remote/connector-contract.js';
import { log } from '../../src/remote/logger.js';
import type { OAuthConfig } from '../../src/auth/oauth-flow.js';
import { settlesWithin } from './login-harness.js';

// Captures the instance a call throws, so an assertion can be made about its TYPE and fields.
// expect(...).toThrow() only matches a message or a class, which is not enough for the chain flags.
function thrown<T>(fn: () => unknown): T {
  try {
    fn();
  } catch (e: unknown) {
    return e as T;
  }
  throw new Error('expected the call to throw, and it did not');
}

// Ages every spend in a refresh directory past the repeat-grace window and drops the stored
// answers, so a later presentation is judged as a REPLAY rather than as a client retry. Tests that
// mean theft say so with this; tests that mean a retry do not.
function pastGraceWindow(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name.endsWith('.repeat')) {
      rmSync(path);
      continue;
    }
    if (!name.endsWith('.spent')) continue;
    const file = new EncryptedFile(path, config.clientSecret);
    file.save({ ...(file.load<Record<string, unknown>>() ?? {}), spentAt: Date.now() - 3_600_000 });
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const config: OAuthConfig = {
  subdomain: 'acme',
  clientId: 'cid',
  clientSecret: 'server-secret-that-is-long-enough',
  callbackPort: 8976,
  scopes: ['read', 'write'],
};

const client = { client_id: 'claude.ai' } as OAuthClientInformationFull;
const otherClient = { client_id: 'evil.example' } as OAuthClientInformationFull;
const CALLBACK_URL = 'https://connector.example.eu/callback';

// A live Zendesk session for every identity the exchange persists: a Zendesk access token that is
// still inside its lifetime, so the liveness probe in exchangeRefreshToken succeeds without network.
const LIVE_UPSTREAM = { accessToken: 'zd-at', refreshToken: 'zd-rt', expiresAt: Date.now() + 3_600_000 };

interface Built {
  provider: ZendeskBridgeOAuthProvider;
  resolver: IdentityAuthResolver;
  issued: IssuedTokenStore;
  refresh: RefreshTokenStore | undefined;
  dir: string;
  setUserId: (id: number) => void;
}

// refreshGrant=false models the pinned contract saying claude.ai does NOT use a refresh grant:
// remote-server then constructs the provider without a refresh store, and the grant is inert.
function build({ refreshGrant = true, brokenRevoke = false }: { refreshGrant?: boolean; brokenRevoke?: boolean } = {}): Built {
  const dir = mkdtempSync(join(tmpdir(), 'zd-refresh-'));
  dirs.push(dir);
  const resolver = new IdentityAuthResolver(new IdentityTokenStore(join(dir, 'users'), config.clientSecret), config);
  const issued = new IssuedTokenStore(join(dir, 'issued'), config.clientSecret);
  // revokeChain writes; on a full disk it throws. The refusal must survive that.
  class UnrevokableStore extends RefreshTokenStore {
    revokeChain(): number {
      throw new Error('ENOSPC: no space left on device');
    }
  }
  const Store = brokenRevoke ? UnrevokableStore : RefreshTokenStore;
  const refresh = refreshGrant ? new Store(join(dir, 'refresh'), config.clientSecret, CONNECTOR.refreshTtlMs) : undefined;
  let userId = 777;
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/oauth/tokens')) {
      return new Response(JSON.stringify({ access_token: 'zd-at', refresh_token: 'zd-rt', expires_in: 3600 }), { status: 200 });
    }
    if (u.includes('/users/me.json')) return new Response(JSON.stringify({ user: { id: userId } }), { status: 200 });
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  const provider = new ZendeskBridgeOAuthProvider(
    config,
    resolver,
    issued,
    CONNECTOR.clientsStore(),
    fetchImpl,
    CALLBACK_URL,
    refresh,
  );
  return { provider, resolver, issued, refresh, dir, setUserId: (id) => (userId = id) };
}

// Run a full authorize-code exchange so an identity exists with a live upstream session.
async function firstLogin(b: Built): Promise<{ access_token: string; refresh_token?: string }> {
  const tokens = await b.provider.exchangeAuthorizationCode(client, 'zcode', 'verifier', 'https://claude.ai/cb');
  return tokens as { access_token: string; refresh_token?: string };
}

describe('AC1 — token mint returns a refresh_token, contract-gated', () => {
  it('mints a refresh_token alongside the access token when the contract enables the grant', async () => {
    const b = build();
    const tokens = await firstLogin(b);
    expect(tokens.access_token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.refresh_token).toMatch(/^[0-9a-f]{64}$/);
    // The two are distinct secrets, not the same opaque value handed out twice.
    expect(tokens.refresh_token).not.toBe(tokens.access_token);
  });

  it('expires_in reports the issued-store TTL rather than a second, drift-prone literal', async () => {
    const b = build();
    const tokens = (await firstLogin(b)) as unknown as { expires_in: number };
    expect(tokens.expires_in).toBe(b.issued.ttlSeconds);
    expect(b.issued.ttlSeconds).toBe(3600); // the store's own default TTL, in seconds
  });

  it('stays inert when the pinned contract says claude.ai does not use a refresh grant', async () => {
    const b = build({ refreshGrant: false });
    const tokens = await firstLogin(b);
    expect(tokens.access_token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.refresh_token).toBeUndefined();
    await expect(b.provider.exchangeRefreshToken(client, 'anything')).rejects.toBeInstanceOf(InvalidGrantError);
  });
});

describe('AC2 — exchangeRefreshToken validates, confirms a live session, mints a fresh access token', () => {
  it('mints a usable access token bound to the same identity', async () => {
    const b = build();
    const first = await firstLogin(b);
    const refreshed = (await b.provider.exchangeRefreshToken(client, first.refresh_token!)) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type: string;
    };

    expect(refreshed.token_type).toBe('Bearer');
    expect(refreshed.access_token).toMatch(/^[0-9a-f]{64}$/);
    expect(refreshed.access_token).not.toBe(first.access_token);
    expect(refreshed.expires_in).toBe(b.issued.ttlSeconds);
    // Same identity, and the new token actually verifies.
    const info = await b.provider.verifyAccessToken(refreshed.access_token);
    expect(info.extra?.identity).toBe('zendesk:777');
    expect(info.clientId).toBe('claude.ai');
  });

  it('refuses when the liveness probe rejects, and settles rather than hanging', async () => {
    const b = build();
    const first = await firstLogin(b);
    vi.spyOn(b.resolver, 'forIdentity').mockReturnValue({
      getAccessToken: () => Promise.reject(new Error('upstream refresh failed — run the zendesk_login tool')),
    });
    const err = await settlesWithin(
      'exchangeRefreshToken with a rejecting liveness probe',
      b.provider.exchangeRefreshToken(client, first.refresh_token!),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidGrantError);
  });

  it('refuses, and says so as an internal error, when the store fails in an unforeseen way', async () => {
    const b = build();
    const first = await firstLogin(b);
    // Not one of the store's refusal types: an I/O failure or a bug. The client still gets a clean
    // refusal (AC4: never a 500), but the log must NOT disguise it as an ordinary bad token.
    vi.spyOn(b.refresh!, 'consume').mockImplementation(() => {
      throw new TypeError('cannot read properties of undefined');
    });
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const err = await b.provider.exchangeRefreshToken(client, first.refresh_token!).catch((e: unknown) => e);
    spy.mockRestore();
    expect(err).toBeInstanceOf(InvalidGrantError);
    expect(written.join('')).toContain('unexpected internal error');
  });

  it('refuses when the liveness probe throws SYNCHRONOUSLY, never leaking a 500-shaped error', async () => {
    const b = build();
    const first = await firstLogin(b);
    // forIdentity() constructs an AuthManager over a store; a synchronous throw here must not escape
    // the OAuth error contract just because it never became a rejected promise.
    vi.spyOn(b.resolver, 'forIdentity').mockImplementation(() => {
      throw new Error('store construction blew up');
    });
    const err = await settlesWithin(
      'exchangeRefreshToken with a synchronously throwing probe',
      b.provider.exchangeRefreshToken(client, first.refresh_token!),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidGrantError);
  });
});

describe('AC3 — refresh tokens are single-use with rotation', () => {
  it('issues a NEW refresh token and invalidates the presented one', async () => {
    const b = build();
    const first = await firstLogin(b);
    const second = (await b.provider.exchangeRefreshToken(client, first.refresh_token!)) as { refresh_token?: string };

    expect(second.refresh_token).toMatch(/^[0-9a-f]{64}$/);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    // Rotation is not a one-shot chain break: the new token rotates again.
    const third = (await b.provider.exchangeRefreshToken(client, second.refresh_token!)) as { refresh_token?: string };
    expect(third.refresh_token).not.toBe(second.refresh_token);
    pastGraceWindow(join(b.dir, 'refresh'));
    // Replay of a spent ancestor is refused AND takes the whole family with it (RFC 6819 5.2.2.3):
    // a replay means someone else holds a copy, so the live descendant must not survive either.
    await expect(b.provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(b.provider.exchangeRefreshToken(client, third.refresh_token!)).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('revocation is chain-scoped: one user\'s replay never touches another session', async () => {
    const b = build();
    const victim = await firstLogin(b);
    b.setUserId(888);
    const bystander = await firstLogin(b); // a separate login starts its own rotation family
    // Spend and then replay the victim's token: its chain dies.
    await b.provider.exchangeRefreshToken(client, victim.refresh_token!);
    pastGraceWindow(join(b.dir, 'refresh'));
    await expect(b.provider.exchangeRefreshToken(client, victim.refresh_token!)).rejects.toBeInstanceOf(InvalidGrantError);
    // The bystander is untouched — revoking every chain on any replay would be a denial-of-service.
    const ok = (await b.provider.exchangeRefreshToken(client, bystander.refresh_token!)) as { access_token: string };
    expect((await b.provider.verifyAccessToken(ok.access_token)).extra?.identity).toBe('zendesk:888');
  });

  it('spends the presented token even when the subsequent liveness check fails (no replay window)', async () => {
    const b = build();
    const first = await firstLogin(b);
    b.resolver.revoke('zendesk:777');
    await expect(b.provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toBeInstanceOf(InvalidGrantError);
    // Restore a live session: the burnt token must STILL be refused, not resurrected.
    b.resolver.persist('zendesk:777', LIVE_UPSTREAM);
    await expect(b.provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toBeInstanceOf(InvalidGrantError);
  });

  // In-process only, and now named as such: the cross-process guarantee is proved by spawning real
  // processes in refresh-grant.concurrency.test.ts, not by this.
  it('consume spends a token once and refuses a second presentation as a replay', () => {
    const b = build();
    const token = b.refresh!.mint('zendesk:777', 'claude.ai');
    expect(b.refresh!.consume(token).record).toMatchObject({ identity: 'zendesk:777', clientId: 'claude.ai' });
    pastGraceWindow(join(b.dir, 'refresh'));
    expect(() => b.refresh!.consume(token)).toThrow(RefreshTokenReplayError);
  });

});

describe('AC4 — per-user isolation; unknown/expired/reused tokens refused, never a 500', () => {
  it('a refresh token for identity A never mints a token for identity B', async () => {
    const b = build();
    const a = await firstLogin(b); // identity 777
    b.setUserId(888);
    const other = await firstLogin(b); // identity 888
    expect(a.refresh_token).not.toBe(other.refresh_token);

    const fromA = (await b.provider.exchangeRefreshToken(client, a.refresh_token!)) as { access_token: string };
    const fromB = (await b.provider.exchangeRefreshToken(client, other.refresh_token!)) as { access_token: string };
    expect((await b.provider.verifyAccessToken(fromA.access_token)).extra?.identity).toBe('zendesk:777');
    expect((await b.provider.verifyAccessToken(fromB.access_token)).extra?.identity).toBe('zendesk:888');
  });

  it('refuses a refresh token presented by a DIFFERENT client (token substitution)', async () => {
    const b = build();
    const first = await firstLogin(b);
    await expect(b.provider.exchangeRefreshToken(otherClient, first.refresh_token!)).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('refuses an ACCESS token presented as a refresh token, and vice versa (cross-store substitution)', async () => {
    const b = build();
    const first = await firstLogin(b);
    // Access token in the refresh slot: the stores are separate namespaces on disk.
    await expect(b.provider.exchangeRefreshToken(client, first.access_token)).rejects.toBeInstanceOf(InvalidGrantError);
    // Refresh token in the bearer slot: must not authenticate an MCP request.
    await expect(b.provider.verifyAccessToken(first.refresh_token!)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it.each([
    ['empty string', ''],
    ['unknown 64-hex token', 'f'.repeat(64)],
    ['path traversal attempt', '../../users/' + 'a'.repeat(40)],
    ['absolute path attempt', '/etc/passwd'],
    ['NUL byte', 'abc\0def'],
    ['oversized blob', 'z'.repeat(100_000)],
  ])('refuses a %s as InvalidGrantError, never a crash or a 500', async (_label, token) => {
    const b = build();
    await firstLogin(b);
    const err = await settlesWithin(`exchangeRefreshToken(${_label})`, b.provider.exchangeRefreshToken(client, token)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InvalidGrantError);
  });

  it('refuses an expired refresh token', async () => {
    const b = build();
    const dir = join(b.dir, 'refresh-short');
    const shortLived = new RefreshTokenStore(dir, config.clientSecret, 1); // 1 ms TTL
    const token = shortLived.mint('zendesk:777', 'claude.ai');
    await new Promise((r) => setTimeout(r, 5));
    expect(() => shortLived.consume(token)).toThrow(InvalidTokenError);
  });

  it('refuses a TAMPERED refresh-token file instead of crashing on the GCM auth tag', async () => {
    const b = build();
    const first = await firstLogin(b);
    const refreshDir = join(b.dir, 'refresh');
    for (const name of readdirSync(refreshDir)) writeFileSync(join(refreshDir, name), 'not-base64-ciphertext');
    const err = await b.provider.exchangeRefreshToken(client, first.refresh_token!).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidGrantError);
  });
});

describe('AC5 — encrypted at rest, never logged, pruned on expiry', () => {
  it('never writes the refresh token or the identity to disk in cleartext', async () => {
    const b = build();
    const first = await firstLogin(b);
    const refreshDir = join(b.dir, 'refresh');
    const names = readdirSync(refreshDir);
    const live = names.filter((n) => n.endsWith('.enc'));
    expect(live).toHaveLength(1);
    // Filename is sha256(token), not the bearer itself.
    expect(live[0]).toMatch(/^[0-9a-f]{64}\.enc$/);
    expect(live[0]).not.toContain(first.refresh_token!);
    // The chain head is a second record and is encrypted on exactly the same terms.
    expect(names.filter((n) => n.endsWith('.chain'))).toHaveLength(1);
    const raw = names.map((n) => readFileSync(join(refreshDir, n), 'utf8')).join('');
    expect(raw).not.toContain(first.refresh_token!);
    // Ciphertext, not JSON: the plaintext record's own field names must not be readable.
    expect(raw).not.toContain('accessToken');
    expect(raw).not.toContain('zendesk:');
    expect(raw).not.toContain('claude.ai');
  });

  it('the refresh token is redacted by the structured logger', () => {
    const b = build();
    const token = b.refresh!.mint('zendesk:777', 'claude.ai');
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    log({ msg: `refresh rejected for ${token}`, outcome: '400' });
    spy.mockRestore();
    expect(written.join('')).not.toContain(token);
    expect(written.join('')).toContain('[redacted]');
  });

  it('the rejection message carries no token material', async () => {
    const b = build();
    const first = await firstLogin(b);
    await b.provider.exchangeRefreshToken(client, first.refresh_token!);
    pastGraceWindow(join(b.dir, 'refresh'));
    const err = (await b.provider.exchangeRefreshToken(client, first.refresh_token!).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(first.refresh_token!);
    expect(err.message).not.toContain(first.access_token);
    // Latin1-safe: the message rides in an OAuth error body and, on the bearer path, in a header.
    expect(err.message).toMatch(/^[\x20-\x7e]+$/);
  });

  // The sweep itself is covered by issued-token-store.prune.test.ts. What is only true HERE is the
  // consequence: a swept refresh token is unspendable, a surviving one still rotates.
  it('a pruned refresh token can no longer be spent, a surviving one still can', () => {
    const b = build();
    const dir = join(b.dir, 'prune-me');
    const store = new RefreshTokenStore(dir, config.clientSecret, 60_000);
    const live = store.mint('zendesk:777', 'claude.ai');
    const dead = new RefreshTokenStore(dir, config.clientSecret, 1).mint('zendesk:888', 'claude.ai');
    store.prune(Date.now() + 10);
    expect(store.consume(live).record).toMatchObject({ identity: 'zendesk:777' });
    expect(() => store.consume(dead)).toThrow(InvalidTokenError);
  });

  // No tautology against the definition: this asserts the CONVERSION, which is the only claim the
  // getter makes. Whether the window is reachable at all is a separate, measured question — see the
  // in-memory DCR client store noted at CONNECTOR.refreshTtlMs.
  it('ttlSeconds converts the configured window into the unit expires_in is denominated in', () => {
    const b = build();
    expect(new RefreshTokenStore(join(b.dir, 'ttl'), config.clientSecret, CONNECTOR.refreshTtlMs).ttlSeconds).toBe(
      CONNECTOR.refreshTtlMs / 1000,
    );
  });
});

// The store's defensive paths. Each is reachable in production (a crash mid-write, a concurrent
// sweep, a credential file written before chainId existed), so each is exercised rather than
// assumed — src/auth carries a 100% floor precisely because guesses do not belong on this path.
describe('RefreshTokenStore — the paths that only a damaged store reaches', () => {
  function store(name: string, ttlMs = 3_600_000): { s: RefreshTokenStore; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), `zd-dmg-${name}-`));
    dirs.push(dir);
    return { s: new RefreshTokenStore(dir, config.clientSecret, ttlMs), dir };
  }

  it('revokeChain is a no-op for an unknown chain and for a directory that does not exist', () => {
    const { s, dir } = store('empty');
    expect(s.revokeChain('no-such-chain')).toBe(0);
    expect(new RefreshTokenStore(join(dir, 'never-created'), config.clientSecret, 1_000).revokeChain('c')).toBe(0);
  });

  it('revokeChain is a no-op when the live member is already gone', () => {
    const { s, dir } = store('vanishing');
    const token = s.mint('zendesk:777', 'claude.ai');
    const chain = s.consume(token).record.chainId; // spend it: the chain now has no live member
    expect(readdirSync(dir).filter((n) => n.endsWith('.enc'))).toHaveLength(0);
    expect(s.revokeChain(chain)).toBe(0); // nothing to revoke, and no directory walk to find that out
  });

  it('sweeps a claim left behind by a process that died mid-spend, but never a live one', () => {
    const { s, dir } = store('stale-claim');
    const token = s.mint('zendesk:777', 'claude.ai');
    // Reconstruct the crash: the rename won, the process died before the tombstone was written.
    const live = readdirSync(dir).find((n) => n.endsWith('.enc'))!;
    const claim = `${live}.deadbeef.claim`;
    renameSync(join(dir, live), join(dir, claim));

    // A claim younger than the staleness window must survive: a spend in flight is exactly this,
    // and sweeping it would break the very rename that makes the spend race-free.
    s.prune();
    expect(readdirSync(dir)).toContain(claim);

    // Backdated past the window, it is the residue of a dead process and is swept. Its record
    // carries the family's deadline, so the inherited expiry sweep would have kept it forever.
    const old = Date.now() / 1000 - 3600;
    utimesSync(join(dir, claim), old, old);
    s.prune();
    expect(readdirSync(dir).filter((n) => n.endsWith('.claim'))).toHaveLength(0);
  });

  it('a corrupt chain head degrades to a plain refusal instead of crashing', () => {
    const { s, dir } = store('corrupt-head');
    const token = s.mint('zendesk:777', 'claude.ai');
    s.consume(token);
    pastGraceWindow(dir);
    const head = readdirSync(dir).find((n) => n.endsWith('.chain'))!;
    writeFileSync(join(dir, head), 'not-base64-ciphertext');
    expect(() => s.consume(token)).toThrow(InvalidTokenError);
  });

  it('a corrupt tombstone proves nothing: the replay is refused as merely unknown', () => {
    const { s, dir } = store('corrupt-tombstone');
    const token = s.mint('zendesk:777', 'claude.ai');
    s.consume(token); // leaves a real tombstone
    pastGraceWindow(dir);
    const spent = readdirSync(dir).find((n) => n.endsWith('.spent'))!;
    writeFileSync(join(dir, spent), 'not-base64-ciphertext');
    const err = thrown<Error>(() => s.consume(token));
    // Still refused — but NOT escalated to a chain revocation on evidence that cannot be read.
    expect(err).toBeInstanceOf(InvalidTokenError);
    expect(err).not.toBeInstanceOf(RefreshTokenReplayError);
  });

  it('refuses a claimed token whose record will not decrypt, and leaves no claim file behind', () => {
    const { s, dir } = store('unreadable');
    const token = s.mint('zendesk:777', 'claude.ai');
    const name = readdirSync(dir).find((n) => n.endsWith('.enc'))!;
    writeFileSync(join(dir, name), 'not-base64-ciphertext');
    expect(() => s.consume(token)).toThrow(InvalidTokenError);
    expect(readdirSync(dir).filter((n) => n.endsWith('.claim'))).toHaveLength(0);
  });

  it('refuses a record that belongs to no family at all', () => {
    const { s, dir } = store('chainless');
    // A well-formed record with no rotation family: nothing vouches for it, so under fail-closed
    // membership it is not spendable, rather than spendable with an empty chain.
    const token = 'a'.repeat(64);
    const path = join(dir, `${createHash('sha256').update(token).digest('hex')}.enc`);
    new EncryptedFile(path, config.clientSecret).save({ identity: 'zendesk:777', clientId: 'claude.ai', expiresAt: Date.now() + 60_000 });
    expect(() => s.consume(token)).toThrow(InvalidTokenError);
  });

  it('refuses a record written by an older release, instead of accepting it with no identity', () => {
    const { s, dir } = store('old-schema');
    // The shape main shipped: {accessToken, refreshToken, expiresAt}. Accepting it yields
    // identity === undefined, which only fails two layers later at the Zendesk lookup. A record
    // that is not a record is refused here.
    const token = 'b'.repeat(64);
    const hash = createHash('sha256').update(token).digest('hex');
    new EncryptedFile(join(dir, `${hash}.enc`), config.clientSecret).save({
      accessToken: 'zendesk:777',
      refreshToken: 'claude.ai',
      expiresAt: Date.now() + 60_000,
    });
    expect(() => s.consume(token)).toThrow(InvalidTokenError);

    // A SEPARATE token for the access-token path: consume() above renamed the first one away, so
    // reusing it here would assert "unknown file" and pass no matter what the validation does.
    const bearer = 'd'.repeat(64);
    new EncryptedFile(join(dir, `${createHash('sha256').update(bearer).digest('hex')}.enc`), config.clientSecret).save({
      accessToken: 'zendesk:777',
      refreshToken: 'claude.ai',
      expiresAt: Date.now() + 60_000,
    });
    const issued = new IssuedTokenStore(dir, config.clientSecret, 60_000);
    // Accepting this yields identity === undefined and a bearer that only fails two layers later.
    expect(() => issued.identityFor(bearer)).toThrow(InvalidTokenError);
  });

  it('a record with no expiry is refused rather than immortal', () => {
    const { s, dir } = store('no-expiry');
    const token = 'c'.repeat(64);
    const hash = createHash('sha256').update(token).digest('hex');
    new EncryptedFile(join(dir, `${hash}.enc`), config.clientSecret).save({ identity: 'zendesk:777', clientId: 'claude.ai' });
    expect(() => s.consume(token)).toThrow(InvalidTokenError);
    s.prune(Date.now() + 100 * 365 * 24 * 3600_000); // a century on
    expect(readdirSync(dir).filter((n) => n.endsWith('.enc'))).toHaveLength(0);
  });
});

// These are the properties the chain-head design exists for. They are stated against chains built
// by ROTATING THROUGH THE PROVIDER — the only way a chain is ever built in production — rather than
// by minting members directly, which used to pin a two-member chain the system cannot reach.
describe('rotation chains, as the provider actually builds them', () => {
  it('a family holds exactly one live token however often it rotates', async () => {
    const b = build();
    const refreshDir = join(b.dir, 'refresh');
    let token = (await firstLogin(b)).refresh_token!;
    for (let i = 0; i < 12; i++) {
      const next = (await b.provider.exchangeRefreshToken(client, token)) as { refresh_token?: string };
      token = next.refresh_token!;
      // One live record and one head per family, whatever the chain's length.
      expect(readdirSync(refreshDir).filter((n) => n.endsWith('.enc'))).toHaveLength(1);
      expect(readdirSync(refreshDir).filter((n) => n.endsWith('.chain'))).toHaveLength(1);
    }
    // Twelve rotations spent twelve tokens (the login token and eleven descendants) and left one
    // tombstone each: the evidence trail is exactly the chain's length, no more and no less.
    expect(readdirSync(refreshDir).filter((n) => n.endsWith('.spent'))).toHaveLength(12);
  });

  it('replaying ANY ancestor kills the live descendant, however deep the chain', async () => {
    const b = build();
    const ancestor = (await firstLogin(b)).refresh_token!;
    let token = ancestor;
    for (let i = 0; i < 6; i++) {
      token = ((await b.provider.exchangeRefreshToken(client, token)) as { refresh_token?: string }).refresh_token!;
    }
    pastGraceWindow(join(b.dir, 'refresh'));
    // The thief holds the very first token; the victim holds the sixth descendant.
    await expect(b.provider.exchangeRefreshToken(client, ancestor)).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(b.provider.exchangeRefreshToken(client, token)).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('evidence lives exactly as long as the family: the oldest tombstone never expires first', async () => {
    const b = build();
    const refreshDir = join(b.dir, 'refresh');
    const ancestor = (await firstLogin(b)).refresh_token!;
    let token = ancestor;
    for (let i = 0; i < 5; i++) {
      token = ((await b.provider.exchangeRefreshToken(client, token)) as { refresh_token?: string }).refresh_token!;
    }
    // Rotation renews the token, NOT the family's deadline — so a sweep at any instant either
    // leaves the whole family standing or takes the evidence and the live token together. There is
    // no window in which the chain is usable but the ancestor's tombstone is already gone.
    const store = new RefreshTokenStore(refreshDir, config.clientSecret, CONNECTOR.refreshTtlMs);
    store.prune(Date.now() + CONNECTOR.refreshTtlMs - 60_000); // just before the family expires
    expect(readdirSync(refreshDir).filter((n) => n.endsWith('.spent')).length).toBeGreaterThan(0);
    await expect(b.provider.exchangeRefreshToken(client, ancestor)).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('the family deadline is ABSOLUTE: rotation renews the token, never the chain', async () => {
    const b = build();
    const store = b.refresh!;
    let rec = store.consume(store.mint('zendesk:777', 'claude.ai')).record;
    const chainDeadline = rec.expiresAt;
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 5)); // make a renewed deadline measurably different
      rec = store.consume(store.rotate(rec, 'claude.ai')).record;
      // A sliding deadline is the evidence-decay defect: the chain would outlive the tombstones
      // that prove a theft against it. The descendant inherits the family's deadline exactly.
      expect(rec.expiresAt).toBe(chainDeadline);
    }
  });

  it('a second replay reports the chain as ALREADY dead, so repeats stay silent and cheap', () => {
    const b = build();
    const store = b.refresh!;
    const token = store.mint('zendesk:777', 'claude.ai');
    store.consume(token);
    pastGraceWindow(join(b.dir, 'refresh'));

    const firstReplay = thrown<RefreshTokenReplayError>(() => store.consume(token));
    expect(firstReplay).toBeInstanceOf(RefreshTokenReplayError);
    expect(firstReplay.alreadyDead).toBe(false); // this one did the revoking

    for (let i = 0; i < 3; i++) {
      const again = thrown<RefreshTokenReplayError>(() => store.consume(token));
      // Without this the provider logs one line per attempt on an unauthenticated path, and the
      // chain's dead state is never recorded at all.
      expect(again.alreadyDead).toBe(true);
      expect(again.revoked).toBe(0);
    }
  });

  // THE acceptance condition from the load finding, stated structurally so it cannot rot into a
  // flaky timing test: a replay must not do work that grows with the directory. A sweep would
  // decrypt once per entry; counting record reads measures exactly that, with no clock involved.
  it('a replay costs a fixed number of record reads, whatever the directory holds', () => {
    class CountingStore extends RefreshTokenStore {
      reads = 0;
      protected read(path: string): OpaqueRecord | null {
        this.reads += 1;
        return super.read(path);
      }
    }
    const dir = mkdtempSync(join(tmpdir(), 'zd-cost-'));
    dirs.push(dir);
    const store = new CountingStore(dir, config.clientSecret, 3_600_000);
    const token = store.mint('zendesk:777', 'claude.ai');
    store.consume(token);
    pastGraceWindow(dir);

    const replay = (): number => {
      store.reads = 0;
      try {
        store.consume(token);
      } catch {
        /* refused, as it must be */
      }
      return store.reads;
    };

    const small = replay();
    for (let i = 0; i < 500; i++) store.mint(`zendesk:${i}`, 'claude.ai'); // 500 unrelated families
    const large = replay();
    expect(large).toBe(small);
    expect(large).toBeLessThanOrEqual(2); // the tombstone, and at most the chain head
  });
});

// The failure paths of the chain machinery itself. Each is reachable in production (a full disk, a
// file vanishing under a sweep, a head lost to a partial restore), and src/auth carries a 100%
// floor precisely because a guess on this path is not worth having.
describe('RefreshTokenStore — when the chain machinery itself fails', () => {
  function dirFor(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `zd-chain-${name}-`));
    dirs.push(dir);
    return dir;
  }

  // Refuses to write the tombstone, the way a full disk does.
  class NoTombstoneStore extends RefreshTokenStore {
    protected writeTombstone(token: string, rec: RefreshRecord & { spentAt: number }): void {
      throw new Error('ENOSPC: no space left on device');
    }
  }

  it('kills the family when the tombstone cannot be written, so the loss of evidence is not a loophole', () => {
    const dir = dirFor('enospc');
    const store = new NoTombstoneStore(dir, config.clientSecret, 60_000);
    const token = store.mint('zendesk:777', 'claude.ai');
    expect(() => store.consume(token)).toThrow(/ENOSPC/);

    // Without a tombstone this exact token will later read as "unknown" rather than as a replay —
    // that much is genuinely lost. What must NOT be lost is the family: it is marked dead, so the
    // chain cannot be used by whoever else may hold a copy.
    const head = readdirSync(dir).find((n) => n.endsWith('.chain'))!;
    const state = new EncryptedFile(join(dir, head), config.clientSecret).load<{ dead: boolean; liveHash: string }>();
    expect(state?.dead).toBe(true);
    expect(state?.liveHash).toBe('');
  });

  it('reports the disk failure, not a secondary failure, when the revocation ALSO fails', () => {
    const dir = dirFor('double-fault');
    class AlsoUnrevokableStore extends NoTombstoneStore {
      revokeChain(): number {
        throw new Error('secondary failure while revoking');
      }
    }
    const store = new AlsoUnrevokableStore(dir, config.clientSecret, 60_000);
    const token = store.mint('zendesk:777', 'claude.ai');
    // The caller must see the cause, not the clean-up's own error on top of it.
    expect(() => store.consume(token)).toThrow(/ENOSPC/);
  });

  it('refuses to rotate a family whose head is gone', () => {
    const dir = dirFor('headless');
    const store = new RefreshTokenStore(dir, config.clientSecret, 60_000);
    // The spend half of this is the `head deleted` row of the fail-closed table below, with a
    // stronger body; only the rotate refusal is stated nowhere else.
    expect(() =>
      store.rotate({ identity: 'zendesk:777', clientId: 'claude.ai', chainId: 'gone', expiresAt: Date.now() + 60_000 }, 'claude.ai'),
    ).toThrow(InvalidTokenError);
  });

  it('revoking a family whose live token file is already gone costs nothing and reports zero', () => {
    const dir = dirFor('gone');
    const store = new RefreshTokenStore(dir, config.clientSecret, 60_000);
    const token = store.mint('zendesk:777', 'claude.ai');
    const chainId = store.consume(token).record.chainId;
    const live = store.rotate({ identity: 'zendesk:777', clientId: 'claude.ai', chainId, expiresAt: Date.now() + 60_000 }, 'claude.ai');
    // Someone removed the live record out of band (a manual clean-up, a half-finished restore).
    rmSync(join(dir, `${createHash('sha256').update(live).digest('hex')}.enc`));
    expect(store.revokeChain(chainId)).toBe(0);
  });

  it('ignores a claim that disappears between the listing and the staleness check', () => {
    const dir = dirFor('vanishing-claim');
    const store = new RefreshTokenStore(dir, config.clientSecret, 60_000);
    // A dangling symlink is named by readdirSync but cannot be stat'ed — the same shape as a file
    // removed by a concurrent sweep, without needing to win a real race.
    symlinkSync(join(dir, 'nothing-here'), join(dir, 'ghost.claim'));
    expect(() => store.prune()).not.toThrow();
  });
});

// The inversion this round forced: revocation no longer has to FIND the stolen successor; the
// token has to prove a living family that names it. Every way a head can lose the truth is a
// refusal. These are the five damage pictures from the torn-head probe, as a suite.
describe('fail-closed membership — a damaged chain head never frees a stolen token', () => {
  function chainWithLiveSuccessor(name: string): { store: RefreshTokenStore; dir: string; ancestor: string; successor: string } {
    const dir = mkdtempSync(join(tmpdir(), `zd-fc-${name}-`));
    dirs.push(dir);
    const store = new RefreshTokenStore(dir, config.clientSecret, 3_600_000);
    const ancestor = store.mint('zendesk:777', 'claude.ai');
    const successor = store.rotate(store.consume(ancestor).record, 'claude.ai');
    pastGraceWindow(dir); // this suite is about THEFT, not about a client retry
    return { store, dir, ancestor, successor };
  }

  const headOf = (dir: string): string => join(dir, readdirSync(dir).find((n) => n.endsWith('.chain'))!);

  it.each([
    ['head intact (control)', (_dir: string) => undefined],
    ['head emptied', (dir: string) => writeFileSync(headOf(dir), '')],
    ['head is garbage bytes', (dir: string) => writeFileSync(headOf(dir), 'not-base64-ciphertext')],
    ['head is valid ciphertext, foreign plaintext', (dir: string) => new EncryptedFile(headOf(dir), config.clientSecret).save({ something: 'else' })],
    ['head deleted', (dir: string) => rmSync(headOf(dir))],
  ])('%s: the replay is refused AND the stolen successor is dead', (_label, damage) => {
    const { store, dir, ancestor, successor } = chainWithLiveSuccessor(String(_label).slice(0, 8));
    damage(dir);
    expect(() => store.consume(ancestor)).toThrow(InvalidTokenError);
    // THE acceptance condition. Three of these five damage pictures used to leave this spendable
    // while still reporting the replay as detected.
    expect(() => store.consume(successor)).toThrow(InvalidTokenError);
    // And the family is left PROVABLY dead rather than merely unverifiable, whatever shape the old
    // head was in — otherwise a later restore of the directory could resurrect it.
    const head = readdirSync(dir).find((n) => n.endsWith('.chain'));
    expect(head).toBeDefined();
    expect(new EncryptedFile(join(dir, head!), config.clientSecret).load<{ dead: boolean }>()?.dead).toBe(true);
  });

  it('writes the head BEFORE the record it names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zd-wo-'));
    dirs.push(dir);
    const order: string[] = [];
    class RecordingStore extends RefreshTokenStore {
      protected write(path: string, rec: RefreshRecord): void {
        if (path.endsWith('.enc')) order.push('record');
        super.write(path, rec);
      }
      protected writeChain(chainId: string, head: ChainHead): void {
        order.push('head');
        super.writeChain(chainId, head);
      }
    }
    const store = new RecordingStore(dir, config.clientSecret, 3_600_000);
    store.mint('zendesk:777', 'claude.ai');
    // Record-then-head would leave a LIVE record no head names when a crash lands between the two:
    // an orphan revocation can never find. The order is the only thing standing between those two
    // half-finished states, so it is asserted directly rather than inferred from a crash test.
    expect(order).toEqual(['head', 'record']);
  });

  it('a crash between the head write and the record write leaves no spendable orphan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zd-order-'));
    dirs.push(dir);
    class CrashAfterHead extends RefreshTokenStore {
      protected write(path: string, rec: RefreshRecord): void {
        if (path.endsWith('.enc') && this.armed) throw new Error('CRASH between the two writes');
        super.write(path, rec);
      }
      armed = false;
    }
    const store = new CrashAfterHead(dir, config.clientSecret, 3_600_000);
    const rec = store.consume(store.mint('zendesk:777', 'claude.ai')).record;
    store.armed = true;
    expect(() => store.rotate(rec, 'claude.ai')).toThrow(/CRASH/);
    store.armed = false;
    // Head-first ordering: the crash leaves a head naming a record that does not exist, which is a
    // refusal. Record-first would have left a live record no head names — a token nobody can revoke.
    expect(readdirSync(dir).filter((n) => n.endsWith('.enc'))).toHaveLength(0);
  });

  it('a clock that jumps past the deadline and back does not burn an honest token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zd-clock-'));
    dirs.push(dir);
    const store = new RefreshTokenStore(dir, config.clientSecret, 60_000);
    const token = store.mint('zendesk:777', 'claude.ai');
    // try/finally, not bare assignment: a failing assertion in between would otherwise leave the
    // global clock an hour fast for every later test that happens to share this worker. That is
    // exactly what it did on the first run of this suite — three unrelated files went red.
    const real = Date.now;
    try {
      Date.now = () => real() + 3_600_000; // the clock steps an hour forward
      expect(() => store.consume(token)).toThrow(/expired/);
    } finally {
      Date.now = real; // ...and NTP corrects it
    }
    // Expiry is judged before anything is destroyed, so the token survives the excursion instead of
    // coming back as a replay that revokes the user's whole chain.
    expect(store.consume(token).record).toMatchObject({ identity: 'zendesk:777' });
  });

  it('a swept stale claim still leaves evidence, so a later replay reads as a replay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zd-claimev-'));
    dirs.push(dir);
    const store = new RefreshTokenStore(dir, config.clientSecret, 3_600_000);
    const token = store.mint('zendesk:777', 'claude.ai');
    const live = readdirSync(dir).find((n) => n.endsWith('.enc'))!;
    const claim = `${live}.deadbeef.claim`;
    renameSync(join(dir, live), join(dir, claim)); // a process died mid-spend
    const old = Date.now() / 1000 - 3600;
    utimesSync(join(dir, claim), old, old);

    store.prune();
    pastGraceWindow(dir);
    // mtime is a weak liveness signal, so the sweep is made harmless to DETECTION even when it is
    // wrong: the grant is gone either way, but the tombstone survives it.
    expect(readdirSync(dir).filter((n) => n.endsWith('.spent'))).toHaveLength(1);
    expect(thrown<Error>(() => store.consume(token))).toBeInstanceOf(RefreshTokenReplayError);
  });
});

// The last structural guards. Each is a way a file on disk can be well-encrypted and still not be
// the thing its name claims, which is precisely where an unchecked cast used to let it through.
describe('record validation — encrypted is not the same as valid', () => {
  function freshDir(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `zd-val-${name}-`));
    dirs.push(dir);
    return dir;
  }

  it('prune removes a record whose plaintext carries no expiry at all', () => {
    const dir = freshDir('no-exp');
    const store = new RefreshTokenStore(dir, config.clientSecret, 60_000);
    new EncryptedFile(join(dir, `${'0'.repeat(64)}.enc`), config.clientSecret).save({ identity: 'zendesk:777' });
    // Without the expiry check `now >= undefined` is false forever and the record is immortal.
    store.prune(Date.now() + 1);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('a chain head with a non-numeric expiry is not a head', () => {
    const dir = freshDir('head-exp');
    const store = new RefreshTokenStore(dir, config.clientSecret, 60_000);
    const token = store.mint('zendesk:777', 'claude.ai');
    const head = readdirSync(dir).find((n) => n.endsWith('.chain'))!;
    new EncryptedFile(join(dir, head), config.clientSecret).save({ liveHash: 'x', dead: false, expiresAt: 'soon' });
    expect(() => store.consume(token)).toThrow(InvalidTokenError);
  });

  it('the claim sweep does not overwrite a tombstone that already exists', () => {
    const dir = freshDir('twice');
    const store = new RefreshTokenStore(dir, config.clientSecret, 3_600_000);
    const token = store.mint('zendesk:777', 'claude.ai');
    const rec = store.consume(token).record; // writes the real tombstone
    const spentBefore = readFileSync(join(dir, readdirSync(dir).find((n) => n.endsWith('.spent'))!), 'utf8');

    // A stale claim for the SAME token turns up (a crashed retry). Its conversion must not clobber
    // the tombstone the successful spend already wrote.
    const claim = `${createHash('sha256').update(token).digest('hex')}.enc.deadbeef.claim`;
    new EncryptedFile(join(dir, claim), config.clientSecret).save({ ...rec, identity: 'zendesk:impostor' });
    const old = Date.now() / 1000 - 3600;
    utimesSync(join(dir, claim), old, old);
    store.prune();

    const spentAfter = readFileSync(join(dir, readdirSync(dir).find((n) => n.endsWith('.spent'))!), 'utf8');
    expect(spentAfter).toBe(spentBefore);
    expect(readdirSync(dir).filter((n) => n.endsWith('.claim'))).toHaveLength(0);
  });
});

// The distinction this round turned on: "somebody else is spending this token right now" and
// "this token was spent long ago and is being replayed" are different events. Treating them alike
// logged the user out for their own correct retry behaviour — measured 4 of 4 cases dead.
describe('a retry is not a theft', () => {
  it('a client that retries after a lost response gets the SAME token pair, not a dead session', async () => {
    const b = build();
    const first = await firstLogin(b);
    const a1 = (await b.provider.exchangeRefreshToken(client, first.refresh_token!)) as Record<string, unknown>;
    // The 200 never reached the client, so it asks again with the token it still has.
    const a2 = (await b.provider.exchangeRefreshToken(client, first.refresh_token!)) as Record<string, unknown>;
    expect(a2).toEqual(a1); // idempotent: the same bytes, not a second rotation
    // And the session is still usable afterwards.
    const onward = (await b.provider.exchangeRefreshToken(client, String(a2.refresh_token))) as Record<string, unknown>;
    expect(onward.access_token).toBeDefined();
  });

  it('the repeat rotates nothing: one spend, one successor, whatever the client asks', async () => {
    const b = build();
    const refreshDir = join(b.dir, 'refresh');
    const first = await firstLogin(b);
    for (let i = 0; i < 4; i++) await b.provider.exchangeRefreshToken(client, first.refresh_token!);
    expect(readdirSync(refreshDir).filter((n) => n.endsWith('.enc'))).toHaveLength(1);
    expect(readdirSync(refreshDir).filter((n) => n.endsWith('.spent'))).toHaveLength(1);
  });

  it('once the window closes the same presentation is theft again', async () => {
    const b = build();
    const first = await firstLogin(b);
    await b.provider.exchangeRefreshToken(client, first.refresh_token!);
    pastGraceWindow(join(b.dir, 'refresh'));
    await expect(b.provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('a concurrent loser is refused WITHOUT revoking the winner out from under them', () => {
    const b = build();
    const store = b.refresh!;
    const token = store.mint('zendesk:777', 'claude.ai');
    const rec = store.consume(token).record;
    // The winner has claimed and tombstoned but has not filed its answer yet — exactly where a
    // second process lands. Revoking here is what took the WINNER's session down too.
    const loser = thrown<Error>(() => store.consume(token));
    expect(loser).toBeInstanceOf(RefreshInFlightError);
    expect(loser).not.toBeInstanceOf(RefreshTokenReplayError);
    // The winner can still finish.
    expect(store.rotate(rec, 'claude.ai')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a revoked family hands out nothing, even inside the window', async () => {
    const b = build();
    const first = await firstLogin(b);
    const granted = (await b.provider.exchangeRefreshToken(client, first.refresh_token!)) as Record<string, unknown>;
    // Revocation stays authoritative: the stored answer is not a back door around it.
    const refreshDir = join(b.dir, 'refresh');
    const chainId = readdirSync(refreshDir).find((n) => n.endsWith('.chain'))!.replace('.chain', '');
    b.refresh!.revokeChain(chainId);
    await expect(b.provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(b.provider.exchangeRefreshToken(client, String(granted.refresh_token))).rejects.toBeInstanceOf(InvalidGrantError);
  });
});

// The five clauses that carried the whole design and were held by no test. Each is asserted on its
// own, so removing exactly that clause turns exactly one test red.
describe('the load-bearing clauses, one test each', () => {
  function chain(name: string): { store: RefreshTokenStore; dir: string; token: string; chainId: string } {
    const dir = mkdtempSync(join(tmpdir(), `zd-lb-${name}-`));
    dirs.push(dir);
    const store = new RefreshTokenStore(dir, config.clientSecret, 3_600_000);
    const token = store.mint('zendesk:777', 'claude.ai');
    const head = readdirSync(dir).find((n) => n.endsWith('.chain'))!;
    return { store, dir, token, chainId: head.replace('.chain', '') };
  }
  const headFile = (dir: string): EncryptedFile =>
    new EncryptedFile(join(dir, readdirSync(dir).find((n) => n.endsWith('.chain'))!), config.clientSecret);

  it('N1: a head that names a DIFFERENT member does not authorise this token', () => {
    const { store, dir, token } = chain('n1');
    const head = headFile(dir).load<Record<string, unknown>>()!;
    headFile(dir).save({ ...head, liveHash: 'f'.repeat(64) }); // alive, but pointing elsewhere
    expect(() => store.consume(token)).toThrow(InvalidTokenError);
  });

  it('N2: a head marked dead does not authorise its own live member', () => {
    const { store, dir, token } = chain('n2');
    const head = headFile(dir).load<Record<string, unknown>>()!;
    headFile(dir).save({ ...head, dead: true }); // liveHash still names this very token
    expect(() => store.consume(token)).toThrow(InvalidTokenError);
  });

  it('N3: a head whose expiry is not a number is not a head', () => {
    const { store, dir, token } = chain('n3');
    const head = headFile(dir).load<Record<string, unknown>>()!;
    headFile(dir).save({ ...head, expiresAt: 'never' });
    expect(() => store.consume(token)).toThrow(InvalidTokenError);
  });

  it('N4: a head with the right liveHash but no `dead` field is not a head', () => {
    const { store, dir, token } = chain('n4');
    const head = headFile(dir).load<Record<string, unknown>>()!;
    // liveHash stays CORRECT, so nothing but the shape check can refuse this. Without it, a missing
    // `dead` reads as falsy and the token is accepted by a head that is not one.
    const { dead, ...withoutDead } = head;
    void dead;
    headFile(dir).save(withoutDead);
    expect(() => store.consume(token)).toThrow(InvalidTokenError);
  });

  it('N10: inside the grace window an unreadable head still refuses the stored answer', async () => {
    const b = build();
    const first = await firstLogin(b);
    await b.provider.exchangeRefreshToken(client, first.refresh_token!); // files the receipt
    const refreshDir = join(b.dir, 'refresh');
    writeFileSync(join(refreshDir, readdirSync(refreshDir).find((n) => n.endsWith('.chain'))!), 'torn');
    // The receipt is a stored constant, not a bypass: without a readable family behind it, the
    // retry is refused like everything else on this surface.
    await expect(b.provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('N13: the stored answer is never handed to a different client, and the family dies with it', async () => {
    const b = build();
    const first = await firstLogin(b);
    const granted = (await b.provider.exchangeRefreshToken(client, first.refresh_token!)) as Record<string, unknown>;

    // Inside the window, but presented by someone else: idempotency is per client, or it is a way
    // to read another client's issued tokens.
    await expect(b.provider.exchangeRefreshToken(otherClient, first.refresh_token!)).rejects.toBeInstanceOf(InvalidGrantError);

    // And the answer is the SAME one the spend path gives: a client substitution revokes the
    // family. Refusing only, because the attempt happened to land inside ten seconds, would be a
    // weaker reply to an identical signal.
    await expect(b.provider.exchangeRefreshToken(client, String(granted.refresh_token))).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('N8: revocation unlinks the live member even when the head can no longer be written', () => {
    const { store, dir, token, chainId } = chain('n8');
    const liveFile = readdirSync(dir).find((n) => n.endsWith('.enc'))!;
    class NoHeadWrite extends RefreshTokenStore {
      protected writeChain(): void {
        throw new Error('ENOSPC: no space left on device');
      }
    }
    const crippled = new NoHeadWrite(dir, config.clientSecret, 3_600_000);
    // Unlink first, mark dead second. Reversed, a full disk would leave the stolen member alive.
    expect(() => crippled.revokeChain(chainId)).toThrow(/ENOSPC/);
    expect(readdirSync(dir)).not.toContain(liveFile);
    expect(() => store.consume(token)).toThrow(InvalidTokenError);
  });
});

// The grace window's own failure paths. A stored receipt is the one place this design keeps an
// answer rather than deriving it, so every way that file can be wrong is stated here.
describe('the grace window, when its own bookkeeping is damaged', () => {
  function spent(name: string): { store: RefreshTokenStore; dir: string; token: string } {
    const dir = mkdtempSync(join(tmpdir(), `zd-gw-${name}-`));
    dirs.push(dir);
    const store = new RefreshTokenStore(dir, config.clientSecret, 3_600_000);
    const token = store.mint('zendesk:777', 'claude.ai');
    store.consume(token);
    return { store, dir, token };
  }
  const repeatFile = (dir: string): string => join(dir, readdirSync(dir).find((n) => n.endsWith('.repeat'))!);

  it('a corrupt receipt is no receipt: the retry is refused, not answered with rubbish', () => {
    const { store, dir, token } = spent('corrupt');
    store.rememberRepeat(token, '{"access_token":"a"}', 'claude.ai', 'chain');
    writeFileSync(repeatFile(dir), 'not-base64-ciphertext');
    expect(thrown<Error>(() => store.consume(token))).toBeInstanceOf(RefreshInFlightError);
  });

  it.each([
    ['payload is not a string', { payload: 42, clientId: 'claude.ai', expiresAt: Date.now() + 10_000 }],
    ['clientId is missing', { payload: '{}', expiresAt: Date.now() + 10_000 }],
    ['expiry is not a number', { payload: '{}', clientId: 'claude.ai', expiresAt: 'soon' }],
    ['receipt already expired', { payload: '{}', clientId: 'claude.ai', expiresAt: Date.now() - 1 }],
  ])('a receipt where the %s is ignored', (_label, body) => {
    const { store, dir, token } = spent('shape');
    store.rememberRepeat(token, '{}', 'claude.ai', 'chain');
    new EncryptedFile(repeatFile(dir), config.clientSecret).save(body);
    expect(thrown<Error>(() => store.consume(token))).toBeInstanceOf(RefreshInFlightError);
  });

  it('a tombstone from before this release has no spentAt and counts as long past, never as fresh', () => {
    const { store, dir, token } = spent('legacy-spentat');
    const file = new EncryptedFile(join(dir, readdirSync(dir).find((n) => n.endsWith('.spent'))!), config.clientSecret);
    const rec = file.load<Record<string, unknown>>()!;
    delete rec.spentAt;
    file.save(rec); // no receipt was ever filed for this spend, so nothing else stands in the way
    // Defaulting the other way would hand every old tombstone a fresh grace window.
    expect(thrown<Error>(() => store.consume(token))).toBeInstanceOf(RefreshTokenReplayError);
  });

  it('a receipt that cannot be filed does not fail the refresh that earned it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zd-gw-unwritable-'));
    dirs.push(dir);
    // A path whose parent is a regular file: the write cannot succeed, and must not propagate.
    writeFileSync(join(dir, 'blocked'), 'not a directory');
    const store = new RefreshTokenStore(join(dir, 'blocked'), config.clientSecret, 3_600_000);
    expect(() => store.rememberRepeat('a'.repeat(64), '{}', 'claude.ai', 'chain')).not.toThrow();
  });

  it('a claim whose name is not a claim is left alone by the sweep', () => {
    const { store, dir } = spent('oddname');
    writeFileSync(join(dir, '.claim'), 'no token hash in front of the infix');
    const old = Date.now() / 1000 - 3600;
    utimesSync(join(dir, '.claim'), old, old);
    expect(() => store.prune()).not.toThrow();
  });
});

// Three assurances added in the final round, each stated on its own so that removing exactly the
// clause behind it turns exactly this test red.
describe('the client-substitution answer, and the ways it can itself fail', () => {
  it('SPEND path: a wrong client revokes the family, not merely this request', async () => {
    const b = build();
    const victim = await firstLogin(b);
    // The legitimate client rotates once, so the family has a live descendant to lose.
    const live = (await b.provider.exchangeRefreshToken(client, victim.refresh_token!)) as Record<string, unknown>;
    pastGraceWindow(join(b.dir, 'refresh')); // out of the window, so this is the SPEND path

    // A second registered client presents the live token. Refusing it alone would leave the thief's
    // copy — and the victim's session — both working.
    await expect(b.provider.exchangeRefreshToken(otherClient, String(live.refresh_token))).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(b.provider.exchangeRefreshToken(client, String(live.refresh_token))).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it.each([
    // The two call sites of refuseClientMismatch. On the SPEND path the token is still live and is
    // presented by the wrong client; on the REPEAT path it was already spent by the right client
    // and the wrong one asks again inside the window.
    ['SPEND path, a live token in the wrong hands', async (b: ReturnType<typeof build>, first: { refresh_token?: string }) => void b],
    ['REPEAT path, inside the grace window', async (b: ReturnType<typeof build>, first: { refresh_token?: string }) =>
      void (await b.provider.exchangeRefreshToken(client, first.refresh_token!))],
  ])('%s: a failing revocation still leaves as invalid_grant, never a 500', async (_label, setup) => {
    const b = build({ brokenRevoke: true });
    const first = await firstLogin(b);
    await setup(b, first);

    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const err = await b.provider.exchangeRefreshToken(otherClient, first.refresh_token!).catch((e: unknown) => e);
    spy.mockRestore();

    // A bare Error here reaches the SDK as a ServerError and answers 500 — the one status an OAuth
    // client does not re-authorize on.
    expect(err).toBeInstanceOf(InvalidGrantError);
    // And the operator is told the theft signal was seen AND that the response to it did not land.
    expect(written.join('')).toContain('could NOT be revoked');
  });

  it('a corrupt stored answer is refused AND logged, not silently dropped', async () => {
    const b = build();
    const first = await firstLogin(b);
    await b.provider.exchangeRefreshToken(client, first.refresh_token!);
    // Inside the window, but the receipt no longer holds JSON: a corrupt store, not client input.
    const refreshDir = join(b.dir, 'refresh');
    const receipt = join(refreshDir, readdirSync(refreshDir).find((n) => n.endsWith('.repeat'))!);
    new EncryptedFile(receipt, config.clientSecret).save({ payload: '{not json', clientId: 'claude.ai', expiresAt: Date.now() + 10_000 });

    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const err = await b.provider.exchangeRefreshToken(client, first.refresh_token!).catch((e: unknown) => e);
    spy.mockRestore();

    expect(err).toBeInstanceOf(InvalidGrantError);
    // Being diagnosable is the whole reason this goes out as a refusal instead of a 500.
    expect(written.join('')).toContain('stored repeat payload is unreadable');
  });
});
