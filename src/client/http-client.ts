import type { RateLimiter } from './rate-limiter.js';
import type { TokenProvider } from './token-provider.js';
import { mapErrorResponse, parseRetryAfter } from './errors.js';

const MAX_RATE_LIMIT_RETRIES = 3;

export interface ZendeskHttpClientOptions {
  // A function where the host is not known yet: the first-run setup page supplies the subdomain
  // mid-session (#68), and a base URL frozen at construction would send every later request to
  // https://.zendesk.com. Every other caller passes the string it already has.
  subdomain: string | (() => string);
  // AuthManager is a TokenProvider, so all existing call sites remain assignable; per-user
  // resolution injects a different TokenProvider per session (M9).
  authManager: TokenProvider;
  rateLimiter: RateLimiter;
  // Optional lower bucket for /incremental/* endpoints (10 req/min global, PRD §5 infra 1).
  // Absent → the 'incremental' rateClass falls back to the default limiter.
  incrementalRateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  maxRateLimitRetries?: number;
}

// Which account-wide bucket a request is metered against. Incremental export is special-cased
// at 10/min; everything else shares the 400/min bucket.
export interface RequestOptions {
  rateClass?: 'default' | 'incremental';
}

export class ZendeskHttpClient {
  private readonly subdomain: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRateLimitRetries: number;

  constructor(private readonly options: ZendeskHttpClientOptions) {
    const { subdomain } = options;
    this.subdomain = typeof subdomain === 'function' ? subdomain : () => subdomain;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? MAX_RATE_LIMIT_RETRIES;
  }

  // Read per request, not cached: see the `subdomain` option.
  private get baseUrl(): string {
    return `https://${this.subdomain()}.zendesk.com/api/v2`;
  }

  // Pick the bucket for this request. 'incremental' selects the 10/min limiter when configured,
  // otherwise falls back to the default so the client is usable without the second limiter.
  private limiterFor(opts: RequestOptions): RateLimiter {
    if (opts.rateClass === 'incremental' && this.options.incrementalRateLimiter) {
      return this.options.incrementalRateLimiter;
    }
    return this.options.rateLimiter;
  }

  // On 429 we feed the Retry-After window to the SAME limiter we acquired from and retry: the
  // next acquire() blocks until the window elapses. This centralizes rate-limit self-healing so
  // paginators and bulk tools don't each reimplement it.
  async request<T>(path: string, init: RequestInit = {}, opts: RequestOptions = {}): Promise<T> {
    const limiter = this.limiterFor(opts);
    // Read ONCE per request, not per attempt: the subdomain can change mid-session (the first-run setup
    // page supplies it), and a retry that picked up the new one would send this request to a different
    // tenant — where the token it carries is not valid anyway.
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      await limiter.acquire();
      const token = await this.options.authManager.getAccessToken();
      const response = await this.fetchImpl(url, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      if (response.status === 429) {
        limiter.reportRetryAfter(parseRetryAfter(response.headers.get('retry-after')));
        if (attempt >= this.maxRateLimitRetries) {
          throw await mapErrorResponse(response);
        }
        continue;
      }
      if (!response.ok) {
        throw await mapErrorResponse(response);
      }
      return (await response.json()) as T;
    }
  }

  // Binary upload path (POST /uploads): the JSON `request` method forces
  // Content-Type: application/json and can't carry raw bytes. This reuses the
  // same auth + rate-limiter + error-mapping seams, single-attempt (uploads
  // are not safely auto-retried on 429 — we surface the typed error instead).
  async requestUpload<T>(path: string, body: Uint8Array, contentType: string): Promise<T> {
    await this.options.rateLimiter.acquire();
    const token = await this.options.authManager.getAccessToken();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      // @types/node types a typed array as Uint8Array<ArrayBufferLike>, which its
      // fetch BodyInit union doesn't accept directly; the raw bytes are a valid
      // BufferSource at runtime, so assert the union member.
      body: body as BodyInit,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    });
    if (response.status === 429) {
      this.options.rateLimiter.reportRetryAfter(parseRetryAfter(response.headers.get('retry-after')));
      throw await mapErrorResponse(response);
    }
    if (!response.ok) {
      throw await mapErrorResponse(response);
    }
    return (await response.json()) as T;
  }
}
