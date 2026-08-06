import { randomUUID } from 'node:crypto';
// The single source of truth for the claude.ai custom-connector contract. Every value marked
// "ASSUMED — pin via Owner spike (Task 0)" is an SDK-documented default that works today; the live
// Owner registration (scripts/spike-remote.mjs) confirms or adjusts it. Downstream code imports
// only these constants, so a contract surprise is a one-file edit, never a rewrite.
// Public HTTPS base URL claude.ai reaches (ops sets REMOTE_PUBLIC_URL on the EU VM). Falls back to
// localhost so the app boots for local tests/smoke without external config.
const PUBLIC_BASE_URL = process.env.REMOTE_PUBLIC_URL || 'http://localhost:8080';
// Minimal in-memory Dynamic Client Registration store (RFC 7591). If the Owner spike shows
// claude.ai uses a pre-registered client_id instead, seed a single client here — no downstream edit.
class InMemoryClientsStore {
    clients = new Map();
    getClient(clientId) {
        return this.clients.get(clientId);
    }
    registerClient(client) {
        // The register handler injects client_id when clientIdGeneration is on; generate one if absent.
        const existingId = client.client_id;
        const clientId = existingId ?? randomUUID();
        const full = { ...client, client_id: clientId };
        this.clients.set(clientId, full);
        return full;
    }
}
export const CONNECTOR = {
    // ASSUMED — pin via Owner spike (Task 0): OAuth discovery documents claude.ai fetches.
    discoveryPaths: {
        authorizationServer: '/.well-known/oauth-authorization-server',
        protectedResource: '/.well-known/oauth-protected-resource',
    },
    // ASSUMED — pin via Owner spike (Task 0): claude.ai requires PKCE S256.
    pkceMethod: 'S256',
    // ASSUMED — pin via Owner spike (Task 0): claude.ai presents our opaque token as an HTTP Bearer.
    bearerFormat: 'Authorization: Bearer <opaque-access-token>',
    // ASSUMED — pin via Owner spike (Task 0): claude.ai performs RFC 7591 dynamic client
    // registration rather than using a pre-shared client_id.
    dynamicClientRegistration: true,
    // Public identifiers advertised in OAuth/discovery metadata.
    issuerUrl: PUBLIC_BASE_URL,
    resourceUrl: `${PUBLIC_BASE_URL}/mcp`,
    clientsStore() {
        return new InMemoryClientsStore();
    },
};
