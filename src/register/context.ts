// src/register/context.ts
import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';
import type { SecurityLevel } from '../security/screen.js';
import type { BusinessHoursConfig } from '../tools/analytics/business-hours.js';

// Shared dependencies threaded into each per-domain tool registrar, instead of the
// registrars closing over module-level singletons. Keeps registration testable and
// server.ts small as later milestones add ~40 more tools.
export interface ToolContext {
  httpClient: ZendeskHttpClient;
  cache: ResponseCache;
  securityLevel: SecurityLevel;
  markdownDefault: boolean;
  // Business-hours basis for zendesk_report (PRD §8). Optional — the analytics registrar
  // falls back to DEFAULT_BUSINESS_HOURS when unset, so pre-M6 ctx construction stays valid.
  reportConfig?: BusinessHoursConfig;
}
