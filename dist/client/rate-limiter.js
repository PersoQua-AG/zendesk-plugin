export class RateLimiter {
    intervalMs;
    now;
    sleepFn;
    nextAvailableAt;
    retryAfterUntil = 0;
    constructor(options) {
        this.intervalMs = 60_000 / options.requestsPerMinute;
        this.now = options.now ?? Date.now;
        this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.nextAvailableAt = this.now();
    }
    async acquire() {
        const current = this.now();
        const waitUntil = Math.max(this.nextAvailableAt, this.retryAfterUntil, current);
        const delay = waitUntil - current;
        if (delay > 0) {
            await this.sleepFn(delay);
        }
        this.nextAvailableAt = waitUntil + this.intervalMs;
    }
    reportRetryAfter(seconds) {
        this.retryAfterUntil = this.now() + seconds * 1000;
    }
}
