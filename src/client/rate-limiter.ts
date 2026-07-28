export interface RateLimiterOptions {
  requestsPerMinute: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  readonly requestsPerMinute: number; // the configured account bucket size, for wiring inspection
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private nextAvailableAt: number;
  private retryAfterUntil = 0;

  constructor(options: RateLimiterOptions) {
    this.requestsPerMinute = options.requestsPerMinute;
    this.intervalMs = 60_000 / options.requestsPerMinute;
    this.now = options.now ?? Date.now;
    this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.nextAvailableAt = this.now();
  }

  async acquire(): Promise<void> {
    const current = this.now();
    const waitUntil = Math.max(this.nextAvailableAt, this.retryAfterUntil, current);
    // Reserve the slot SYNCHRONOUSLY before awaiting so N concurrent acquire() calls
    // serialize onto staggered slots instead of all reading a stale nextAvailableAt and
    // collapsing into one — which would burst past the account cap.
    this.nextAvailableAt = waitUntil + this.intervalMs;
    const delay = waitUntil - current;
    if (delay > 0) {
      await this.sleepFn(delay);
    }
  }

  reportRetryAfter(seconds: number): void {
    this.retryAfterUntil = this.now() + seconds * 1000;
  }
}
