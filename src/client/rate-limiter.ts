export interface RateLimiterOptions {
  requestsPerMinute: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private nextAvailableAt: number;
  private retryAfterUntil = 0;

  constructor(options: RateLimiterOptions) {
    this.intervalMs = 60_000 / options.requestsPerMinute;
    this.now = options.now ?? Date.now;
    this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.nextAvailableAt = this.now();
  }

  async acquire(): Promise<void> {
    const current = this.now();
    const waitUntil = Math.max(this.nextAvailableAt, this.retryAfterUntil, current);
    const delay = waitUntil - current;
    if (delay > 0) {
      await this.sleepFn(delay);
    }
    this.nextAvailableAt = Math.max(waitUntil, current) + this.intervalMs;
  }

  reportRetryAfter(seconds: number): void {
    this.retryAfterUntil = this.now() + seconds * 1000;
  }
}
