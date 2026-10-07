const DEFAULT_RETRY_AFTER_SECONDS = 60;
// Zendesk windows reset each minute; 5 min bounds a bogus header, far below setTimeout's 2^31 ms.
// Lives here, not in rate-limiter.ts, so the parser caps once for both the limiter and the message.
export const MAX_RETRY_AFTER_SECONDS = 300;
export class ZendeskApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = 'ZendeskApiError';
    }
}
export class ZendeskRateLimitError extends ZendeskApiError {
    retryAfterSeconds;
    constructor(retryAfterSeconds) {
        super(`Zendesk rate limit hit; retry after ${retryAfterSeconds}s`, 429);
        this.retryAfterSeconds = retryAfterSeconds;
        this.name = 'ZendeskRateLimitError';
    }
}
export class ZendeskPermissionError extends ZendeskApiError {
    constructor(message) {
        super(message, 403);
        this.name = 'ZendeskPermissionError';
    }
}
export class ZendeskConflictError extends ZendeskApiError {
    constructor(message) {
        super(message, 409);
        this.name = 'ZendeskConflictError';
    }
}
export class ZendeskValidationError extends ZendeskApiError {
    constructor(message) {
        super(message, 422);
        this.name = 'ZendeskValidationError';
    }
}
// Parse a Retry-After header: integer seconds, or an RFC HTTP-date (delta from
// now). Anything unparseable (garbage / missing) falls back to a safe default. Capped, so the
// message the user reads states the wait the limiter actually applies.
export function parseRetryAfter(header, now = Date.now) {
    if (header == null)
        return DEFAULT_RETRY_AFTER_SECONDS;
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed))
        return Math.min(Number(trimmed), MAX_RETRY_AFTER_SECONDS);
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
        return Math.min(Math.max(0, Math.ceil((dateMs - now()) / 1000)), MAX_RETRY_AFTER_SECONDS);
    }
    return DEFAULT_RETRY_AFTER_SECONDS;
}
export async function mapErrorResponse(response) {
    const bodyText = await response.text();
    switch (response.status) {
        case 429:
            return new ZendeskRateLimitError(parseRetryAfter(response.headers.get('retry-after')));
        case 403:
            return new ZendeskPermissionError(`Permission denied (scope ∩ role insufficient): ${bodyText}`);
        case 409:
            return new ZendeskConflictError(`Conflict — resource changed since last read: ${bodyText}`);
        case 422:
            return new ZendeskValidationError(`Validation failed: ${bodyText}`);
        default:
            return new ZendeskApiError(`Zendesk API error ${response.status}: ${bodyText}`, response.status);
    }
}
