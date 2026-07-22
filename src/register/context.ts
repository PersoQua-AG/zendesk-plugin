// src/register/context.ts
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import type { SecurityLevel } from '../security/screen.js';

// Shared dependencies threaded into each per-domain tool registrar, instead of the
// registrars closing over module-level singletons. Keeps registration testable and
// server.ts small as later milestones add ~40 more tools.
export interface ToolContext {
  httpClient: ZendeskHttpClient;
  cache: ResponseCache;
  securityLevel: SecurityLevel;
  markdownDefault: boolean;
}
