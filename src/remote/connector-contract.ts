import { randomUUID } from 'node:crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

// The single source of truth for the claude.ai custom-connector contract. Discovery paths, PKCE
// method, bearer format and dynamic client registration are provider-level concerns the MCP SDK's
// mcpAuthRouter derives from the provider — the refresh grant, PKCE and redirect topology were
// verified in the Task-0 spike. Downstream code imports only these constants.

// Public HTTPS base URL claude.ai reaches (ops sets REMOTE_PUBLIC_URL on the EU VM). Falls back to
// localhost so the app boots for local tests/smoke without external config. In production a
// non-https URL is refused fail-closed — claude.ai and Zendesk both require an https redirect.
const PUBLIC_BASE_URL = requirePublicBaseUrl();

function requirePublicBaseUrl(): string {
  const url = process.env.REMOTE_PUBLIC_URL || 'http://localhost:8080';
  if (process.env.NODE_ENV === 'production' && !url.startsWith('https://')) {
    throw new Error(`REMOTE_PUBLIC_URL must be an https URL in production (got: ${url}).`);
  }
  return url;
}

// Minimal in-memory Dynamic Client Registration store (RFC 7591). If the Owner spike shows
// claude.ai uses a pre-registered client_id instead, seed a single client here — no downstream edit.
// Hard cap on the open DCR store so unauthenticated /register cannot grow it without bound (H1).
const MAX_CLIENTS = 1000;

export class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): OAuthClientInformationFull {
    if (this.clients.size >= MAX_CLIENTS) throw new Error('Client registration limit reached.');
    // The register handler injects client_id when clientIdGeneration is on; generate one if absent.
    const existingId = (client as Partial<OAuthClientInformationFull>).client_id;
    const clientId = existingId ?? randomUUID();
    const full = { ...client, client_id: clientId } as OAuthClientInformationFull;
    this.clients.set(clientId, full);
    return full;
  }
}

let clientsStoreSingleton: OAuthRegisteredClientsStore | undefined;

export const CONNECTOR = {
  // Public identifiers advertised in OAuth/discovery metadata.
  issuerUrl: PUBLIC_BASE_URL,
  resourceUrl: `${PUBLIC_BASE_URL}/mcp`,
  // The upstream Zendesk redirect_uri: must be identical at authorize and at token exchange.
  callbackUrl: `${PUBLIC_BASE_URL}/callback`,
  // ASSUMED, not pinned — no Task-0 spike has run (issue #8 is open; deploy/README.md says the
  // connector runs on SDK-documented defaults until it does). The reasoning is ours, not claude.ai's:
  // the SDK's own metadata advertises grant_types_supported ['authorization_code','refresh_token'],
  // so a client that reads the metadata is told the grant exists, and without it every expiry of the
  // issued access token costs a full browser authorize. That is an argument from OUR metadata, and
  // it is not the same as having watched claude.ai use the grant. #8 sets this value a second time
  // from a live registration. Flip it to false and the grant goes inert end to end — nothing is
  // minted, the metadata stops advertising it, and every refresh is refused.
  refreshGrant: true,
  // Lifetime of a DOWNSTREAM refresh token. CEILING, NOT A PROMISE: the DCR client store is
  // in-memory (InMemoryClientsStore above), so a process restart makes every registered client_id
  // unknown and the next refresh answers 400 invalid_client regardless of what this says. Until the
  // client store is durable the real bound is the process lifetime; see the follow-up noted in #8.
  refreshTtlMs: 30 * 24 * 60 * 60 * 1000, // 30 days, in milliseconds
  // One store instance for the process — registrations must survive across authorize/token calls.
  clientsStore(): OAuthRegisteredClientsStore {
    return (clientsStoreSingleton ??= new InMemoryClientsStore());
  },
} as const;
