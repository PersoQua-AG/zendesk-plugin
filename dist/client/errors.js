const DEFAULT_RETRY_AFTER_SECONDS = 60;
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
// now). Anything unparseable (garbage / missing) falls back to a safe default.
export function parseRetryAfter(header, now = Date.now) {
    if (header == null)
        return DEFAULT_RETRY_AFTER_SECONDS;
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed))
        return Number(trimmed);
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
        return Math.max(0, Math.ceil((dateMs - now()) / 1000));
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
