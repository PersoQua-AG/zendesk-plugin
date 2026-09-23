import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { IdentityTokenStore } from '../../src/auth/identity-store.js';
import { IdentityAuthResolver } from '../../src/auth/identity-resolver.js';
import { IssuedTokenStore, REFRESH_TTL_MS } from '../../src/auth/issued-token-store.js';
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
  refresh: IssuedTokenStore | undefined;
  dir: string;
  userId: () => number;
  setUserId: (id: number) => void;
}

// refreshGrant=false models the pinned contract saying claude.ai does NOT use a refresh grant:
// remote-server then constructs the provider without a refresh store, and the grant is inert.
function build({ refreshGrant = true }: { refreshGrant?: boolean } = {}): Built {
  const dir = mkdtempSync(join(tmpdir(), 'zd-refresh-'));
  dirs.push(dir);
  const resolver = new IdentityAuthResolver(new IdentityTokenStore(join(dir, 'users'), config.clientSecret), config);
  const issued = new IssuedTokenStore(join(dir, 'issued'), config.clientSecret);
  const refresh = refreshGrant ? new IssuedTokenStore(join(dir, 'refresh'), config.clientSecret, REFRESH_TTL_MS) : undefined;
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
  return { provider, resolver, issued, refresh, dir, userId: () => userId, setUserId: (id) => (userId = id) };
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

  it('refuses when the mapped identity no longer resolves to a live Zendesk session', async () => {
    const b = build();
    const first = await firstLogin(b);
    // The per-user Zendesk credentials are gone (GDPR erasure / revoked grant): no live session.
    b.resolver.revoke('zendesk:777');
    await expect(b.provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toBeInstanceOf(InvalidGrantError);
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
    // Replay of the spent token is refused...
    await expect(b.provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toBeInstanceOf(InvalidGrantError);
    // ...while the rotated one still works, so rotation is not a one-shot chain break.
    const third = (await b.provider.exchangeRefreshToken(client, second.refresh_token!)) as { refresh_token?: string };
    expect(third.refresh_token).not.toBe(second.refresh_token);
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

  it('IssuedTokenStore.consume is single-use and refuses the second caller of a concurrent race', () => {
    const b = build();
    const token = b.refresh!.mint('zendesk:777', 'claude.ai');
    expect(b.refresh!.consume(token)).toMatchObject({ identity: 'zendesk:777', clientId: 'claude.ai' });
    expect(() => b.refresh!.consume(token)).toThrow(InvalidTokenError);
  });

  it('IssuedTokenStore.consume refuses when the unlink loses the race to a concurrent consume', () => {
    const b = build();
    const token = b.refresh!.mint('zendesk:777', 'claude.ai');
    // The record still loads, but the file is gone by the time we try to spend it: the unlink IS the
    // single-use gate, so a failed unlink must refuse rather than hand out the grant.
    const spy = vi
      .spyOn(IssuedTokenStore.prototype as unknown as { removeFile: (p: string) => void }, 'removeFile')
      .mockImplementation(() => {
        throw new Error('ENOENT');
      });
    expect(() => b.refresh!.consume(token)).toThrow(InvalidTokenError);
    spy.mockRestore();
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
    ['NUL byte', 'abc def'],
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
    const shortLived = new IssuedTokenStore(dir, config.clientSecret, 1); // 1 ms TTL
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

  it('prunes expired refresh tokens and keeps live ones', () => {
    const b = build();
    const dir = join(b.dir, 'prune-me');
    const store = new IssuedTokenStore(dir, config.clientSecret, 60_000);
    const live = store.mint('zendesk:777', 'claude.ai');
    const dead = new IssuedTokenStore(dir, config.clientSecret, 1).mint('zendesk:888', 'claude.ai');
    expect(readdirSync(dir)).toHaveLength(2);
    store.prune(Date.now() + 10);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(store.consume(live)).toMatchObject({ identity: 'zendesk:777' });
    expect(() => store.consume(dead)).toThrow(InvalidTokenError);
  });

  it('REFRESH_TTL_MS is a bounded multi-day window expressed against its own unit', () => {
    expect(REFRESH_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    const store = new IssuedTokenStore('/tmp/unused-ttl-probe', config.clientSecret, REFRESH_TTL_MS);
    expect(store.ttlSeconds).toBe(2_592_000);
  });
});
