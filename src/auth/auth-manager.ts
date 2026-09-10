import type { TokenStore, StoredTokens } from './token-store.js';
import { refreshAccessToken, type OAuthConfig } from './oauth-flow.js';

const EXPIRY_SKEW_MS = 60_000;

export class AuthManager {
  private cached: StoredTokens | null = null;
  private inFlightRefresh: Promise<StoredTokens> | null = null;

  constructor(
    private readonly store: TokenStore,
    private readonly config: OAuthConfig,
    private readonly refresh: typeof refreshAccessToken = refreshAccessToken,
  ) {}

  async getAccessToken(): Promise<string> {
    const tokens = this.cached ?? (this.cached = this.loadFromStore());
    if (Date.now() < tokens.expiresAt - EXPIRY_SKEW_MS) {
      return tokens.accessToken;
    }
    const refreshed = await this.refreshOnce(tokens.refreshToken);
    return refreshed.accessToken;
  }

  private loadFromStore(): StoredTokens {
    let tokens: StoredTokens | null;
    try {
      tokens = this.store.load();
    } catch {
      // Decrypt/integrity failure (secret rotated or file tampered) — surface an
      // actionable re-auth message instead of a raw GCM crash.
      throw new Error(
        'Stored Zendesk credentials could not be read (encryption secret changed or file corrupt). ' +
          'Run the zendesk_login tool to re-authorize.',
      );
    }
    if (!tokens) {
      throw new Error(
        'No Zendesk authorization found. Run the zendesk_login tool to authorize (from a terminal: `npm run authorize`).',
      );
    }
    return tokens;
  }

  // Single-flight: concurrent callers near expiry share one refresh so the
  // rotating refresh token is spent exactly once.
  private refreshOnce(refreshToken: string): Promise<StoredTokens> {
    if (this.inFlightRefresh) return this.inFlightRefresh;
    this.inFlightRefresh = this.doRefresh(refreshToken).finally(() => {
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  private async doRefresh(refreshToken: string): Promise<StoredTokens> {
    // A dead refresh grant (revoked, rotated, expired) is only recoverable by authorizing again, so
    // say so. First line only, so no stack reaches the user.
    const refreshed = await this.refresh(this.config, refreshToken).catch((err: unknown) => {
      const reason = (err instanceof Error ? err.message : String(err)).split('\n')[0];
      throw new Error(`${reason} — run the zendesk_login tool to authorize again.`);
    });
    const updated: StoredTokens = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: Date.now() + refreshed.expiresIn * 1000,
    };
    this.store.save(updated);
    this.cached = updated;
    return updated;
  }
}
