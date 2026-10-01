import { refreshAccessToken } from './oauth-flow.js';
const EXPIRY_SKEW_MS = 60_000;
// What the token boundary says when nothing can start a login from here (the CLI, the remote bridge).
const NO_AUTHORIZATION = 'No Zendesk authorization found. Run the zendesk_login tool to authorize (from a terminal: `npm run authorize`).';
const UNREADABLE_STORE = 'Stored Zendesk credentials could not be read (encryption secret changed or file corrupt). ' +
    'Run the zendesk_login tool to re-authorize.';
export class AuthManager {
    store;
    config;
    refresh;
    startLogin;
    cached = null;
    inFlightRefresh = null;
    constructor(store, config, refresh = refreshAccessToken, 
    // Starts the login itself when there is nothing usable in the store, and answers with the text
    // the user needs — the authorization URL. Set on the stdio path only; the CLI and the remote
    // bridge leave it unset and keep the "run the login tool" wording.
    startLogin) {
        this.store = store;
        this.config = config;
        this.refresh = refresh;
        this.startLogin = startLogin;
    }
    async getAccessToken() {
        const tokens = this.cached ?? (this.cached = await this.loadFromStore());
        if (Date.now() < tokens.expiresAt - EXPIRY_SKEW_MS) {
            return tokens.accessToken;
        }
        const refreshed = await this.refreshOnce(tokens.refreshToken);
        return refreshed.accessToken;
    }
    async loadFromStore() {
        let tokens = null;
        // Decrypt/integrity failure (key rotated or file tampered) and an empty store are the same
        // situation for the user — there is nothing to authorize with — and both are answered by
        // starting the authorization rather than by naming a tool for them to find.
        let withoutLogin = NO_AUTHORIZATION;
        try {
            tokens = this.store.load();
        }
        catch {
            withoutLogin = UNREADABLE_STORE;
        }
        if (tokens)
            return tokens;
        throw new Error(this.startLogin ? await this.startLogin() : withoutLogin);
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
        // A dead refresh grant (revoked, rotated, expired) is only recoverable by authorizing again, so
        // say so. First line only, so no stack reaches the user.
        const refreshed = await this.refresh(this.config, refreshToken).catch((err) => {
            const reason = (err instanceof Error ? err.message : String(err)).split('\n')[0];
            throw new Error(`${reason} — run the zendesk_login tool to authorize again.`);
        });
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
