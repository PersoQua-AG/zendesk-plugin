// The TokenStore key, for tests. The real one (src/auth/store-key.ts) reaches the macOS Keychain
// through `security`, which no suite may depend on: CI runs on Linux, where that source does not
// exist at all, and a suite that created a real Keychain item on a developer's machine would be
// writing outside the tree. Every call site that resolves a config or builds a server therefore
// injects this instead — it is why resolveAuthConfig and createServer take the seam.
export const TEST_STORE_KEY = 'test-token-store-key-0123456789abcdef';

export const readStoreKey = (): string => TEST_STORE_KEY;

// "Nothing has been stored on this machine yet", for every case that resolves an INCOMPLETE
// configuration. That is exactly when resolveAuthConfig consults the Keychain, so without this a case
// would pass or fail by what the developer running it had set up. Control: make the real reader return
// a complete configuration and twelve cases turn red.
export const noStoredConfig = (): Record<string, never> => ({});
