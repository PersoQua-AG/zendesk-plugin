import type { TokenStore, StoredTokens } from './token-store.js';
import { refreshAccessToken, type OAuthConfig } from './oauth-flow.js';

const EXPIRY_SKEW_MS = 60_000;

export class AuthManager {
  constructor(
    private readonly store: TokenStore,
    private readonly config: OAuthConfig,
    private readonly refresh: typeof refreshAccessToken = refreshAccessToken,
  ) {}

  async getAccessToken(): Promise<string> {
    const tokens = this.store.load();
    if (!tokens) {
      throw new Error('No Zendesk authorization found. Run the OAuth setup flow first.');
    }
    if (Date.now() < tokens.expiresAt - EXPIRY_SKEW_MS) {
      return tokens.accessToken;
    }
    const refreshed = await this.refresh(this.config, tokens.refreshToken);
    const updated: StoredTokens = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: Date.now() + refreshed.expiresIn * 1000,
    };
    this.store.save(updated);
    return updated.accessToken;
  }
}
