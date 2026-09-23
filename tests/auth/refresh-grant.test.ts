import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { IdentityTokenStore } from '../../src/auth/identity-store.js';
import { IdentityAuthResolver } from '../../src/auth/identity-resolver.js';
import { IssuedTokenStore } from '../../src/auth/issued-token-store.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { RefreshTokenStore, RefreshTokenReplayError } from '../../src/auth/refresh-token-store.js';
import { ZendeskBridgeOAuthProvider } from '../../src/remote/bridge-oauth-provider.js';
import { CONNECTOR } from '../../src/remote/connector-contract.js';
import { log } from '../../src/remote/logger.js';
import type { OAuthConfig } from '../../src/auth/oauth-flow.js';
import { settlesWithin } from './login-harness.js';

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
function build({ refreshGrant = true }: { refreshGrant?: boolean } = {}): Built {
  const dir = mkdtempSync(join(tmpdir(), 'zd-refresh-'));
  dirs.push(dir);
  const resolver = new IdentityAuthResolver(new IdentityTokenStore(join(dir, 'users'), config.clientSecret), config);
  const issued = new IssuedTokenStore(join(dir, 'issued'), config.clientSecret);
  const refresh = refreshGrant ? new RefreshTokenStore(join(dir, 'refresh'), config.clientSecret, CONNECTOR.refreshTtlMs) : undefined;
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
    expect(b.refresh!.consume(token)).toMatchObject({ identity: 'zendesk:777', clientId: 'claude.ai' });
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
    expect(names).toHaveLength(1);
    // Filename is sha256(token), not the bearer itself.
    expect(names[0]).toMatch(/^[0-9a-f]{64}\.enc$/);
    expect(names[0]).not.toContain(first.refresh_token!);
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
    expect(store.consume(live)).toMatchObject({ identity: 'zendesk:777' });
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

  it('revokeChain is a no-op for an empty chain id and for a directory that does not exist', () => {
    const { s, dir } = store('empty');
    expect(s.revokeChain('')).toBe(0); // an access-token record carries no chain
    expect(new RefreshTokenStore(join(dir, 'never-created'), config.clientSecret, 1_000).revokeChain('c')).toBe(0);
  });

  it('revokeChain skips a corrupt member and still revokes the readable ones', () => {
    const { s, dir } = store('corrupt-member');
    const chain = 'chain-shared';
    s.mint('zendesk:777', 'claude.ai', chain);
    s.mint('zendesk:777', 'claude.ai', chain);
    writeFileSync(join(dir, 'aaaa.enc'), 'not-base64-ciphertext'); // torn file from a crashed write
    expect(s.revokeChain(chain)).toBe(2); // the two readable members, and no throw
    expect(readdirSync(dir).filter((n) => n.endsWith('.enc'))).toEqual(['aaaa.enc']);
  });

  it('revokeChain ignores a member that vanishes between the listing and the read', () => {
    const { s, dir } = store('vanishing');
    const chain = 'chain-vanish';
    s.mint('zendesk:777', 'claude.ai', chain);
    const name = readdirSync(dir).find((n) => n.endsWith('.enc'))!;
    // A concurrent sweep or consume empties it after readdirSync has already named it:
    // TokenStore.load() then returns null rather than throwing, which is its own branch.
    writeFileSync(join(dir, name), '');
    expect(s.revokeChain(chain)).toBe(0);
  });

  it('a corrupt tombstone proves nothing: the replay is refused as merely unknown', () => {
    const { s, dir } = store('corrupt-tombstone');
    const token = s.mint('zendesk:777', 'claude.ai');
    s.consume(token); // leaves a real tombstone
    const spent = readdirSync(dir).find((n) => n.endsWith('.spent'))!;
    writeFileSync(join(dir, spent), 'not-base64-ciphertext');
    const err = (() => {
      try {
        s.consume(token);
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
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

  it('reads a record written without a chainId as an empty chain rather than undefined', () => {
    const { s, dir } = store('legacy');
    // What a Zendesk-credential file looks like: three slots, no rotation family.
    const token = 'a'.repeat(64);
    const path = join(dir, `${createHash('sha256').update(token).digest('hex')}.enc`);
    new TokenStore(path, config.clientSecret).save({ accessToken: 'zendesk:777', refreshToken: 'claude.ai', expiresAt: Date.now() + 60_000 });
    expect(s.consume(token)).toMatchObject({ identity: 'zendesk:777', clientId: 'claude.ai', chainId: '' });
  });
});
