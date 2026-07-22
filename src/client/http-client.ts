import type { RateLimiter } from './rate-limiter.js';
import type { AuthManager } from '../auth/auth-manager.js';
import { mapErrorResponse } from './errors.js';

export interface ZendeskHttpClientOptions {
  subdomain: string;
  authManager: AuthManager;
  rateLimiter: RateLimiter;
  fetchImpl?: typeof fetch;
}

export class ZendeskHttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ZendeskHttpClientOptions) {
    this.baseUrl = `https://${options.subdomain}.zendesk.com/api/v2`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    await this.options.rateLimiter.acquire();
    const token = await this.options.authManager.getAccessToken();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '60');
      this.options.rateLimiter.reportRetryAfter(retryAfter);
      throw await mapErrorResponse(response);
    }
    if (!response.ok) {
      throw await mapErrorResponse(response);
    }
    return (await response.json()) as T;
  }
}
