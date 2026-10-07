import { MAX_RETRY_AFTER_SECONDS } from './errors.js';
export class RateLimiter {
    requestsPerMinute; // the configured account bucket size, for wiring inspection
    intervalMs;
    now;
    sleepFn;
    nextAvailableAt;
    retryAfterUntil = 0;
    constructor(options) {
        this.requestsPerMinute = options.requestsPerMinute;
        this.intervalMs = 60_000 / options.requestsPerMinute;
        this.now = options.now ?? Date.now;
        this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.nextAvailableAt = this.now();
    }
    async acquire() {
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
    reportRetryAfter(seconds) {
        // Both in-repo callers pass parseRetryAfter output, which is already capped — but this is a
        // public method, and the cap is what keeps NaN out: it fails `<`, so an unknown wait becomes
        // the longest safe one. Without it Math.max below returns NaN and the window stops holding at
        // all. Kept for that property, not for the cap.
        const capped = seconds < MAX_RETRY_AFTER_SECONDS ? seconds : MAX_RETRY_AFTER_SECONDS;
        // Extend, never shorten: a second 429 with a smaller header must not reopen a window
        // Zendesk still holds shut.
        this.retryAfterUntil = Math.max(this.retryAfterUntil, this.now() + capped * 1000);
    }
}
