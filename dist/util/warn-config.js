// Config degradation, announced on stderr — stdout is the MCP stdio transport and must stay
// protocol-clean. One writer for all of it, so tests/plugin/secret-safe-logging.test.ts has a
// single sanctioned one to allowlist. Callers pass field names and values, never a secret.
export function warnConfig(message) {
    console.warn(`[zendesk-plugin] ${message}`);
}
