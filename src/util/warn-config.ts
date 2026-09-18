// Operator config is misconfigurable at boot; degrade to a safe value rather than crash, but never
// swallow silently. Warnings go to stderr (console.warn) — stdout is the MCP stdio transport and
// must stay protocol-clean. Lives here rather than beside one of its callers so every config
// degradation in the server speaks with one voice and one prefix, and so the static stderr guard in
// tests/plugin/secret-safe-logging.test.ts has a single sanctioned writer to allowlist.
// Callers pass their own field names and values — never a secret.
export function warnConfig(message: string): void {
  console.warn(`[zendesk-plugin] ${message}`);
}
