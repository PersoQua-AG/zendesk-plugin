// The minimal auth dependency ZendeskHttpClient needs: hand it a valid bearer token.
// AuthManager already satisfies this; per-user resolution supplies a different impl per session.
export interface TokenProvider {
  getAccessToken(): Promise<string>;
}
