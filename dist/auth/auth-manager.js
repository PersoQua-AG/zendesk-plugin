import { refreshAccessToken } from './oauth-flow.js';
const EXPIRY_SKEW_MS = 60_000;
export class AuthManager {
    store;
    config;
    refresh;
    cached = null;
    inFlightRefresh = null;
    constructor(store, config, refresh = refreshAccessToken) {
        this.store = store;
        this.config = config;
        this.refresh = refresh;
    }
    async getAccessToken() {
        const tokens = this.cached ?? (this.cached = this.loadFromStore());
        if (Date.now() < tokens.expiresAt - EXPIRY_SKEW_MS) {
            return tokens.accessToken;
        }
        const refreshed = await this.refreshOnce(tokens.refreshToken);
        return refreshed.accessToken;
    }
    loadFromStore() {
        let tokens;
        try {
            tokens = this.store.load();
        }
        catch {
            // Decrypt/integrity failure (secret rotated or file tampered) — surface an
            // actionable re-auth message instead of a raw GCM crash.
            throw new Error('Stored Zendesk credentials could not be read (encryption secret changed or file corrupt). Please re-authorize.');
        }
        if (!tokens) {
            throw new Error('No Zendesk authorization found. Run the OAuth setup flow first.');
        }
        return tokens;
    }
    // Single-flight: concurrent callers near expiry share one refresh so the
    // rotating refresh token is spent exactly once.
    refreshOnce(refreshToken) {
        if (this.inFlightRefresh)
            return this.inFlightRefresh;
        this.inFlightRefresh = this.doRefresh(refreshToken).finally(() => {
            this.inFlightRefresh = null;
        });
        return this.inFlightRefresh;
    }
    async doRefresh(refreshToken) {
        const refreshed = await this.refresh(this.config, refreshToken);
        const updated = {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: Date.now() + refreshed.expiresIn * 1000,
        };
        this.store.save(updated);
        this.cached = updated;
        return updated;
    }
}
