export class ZendeskRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Zendesk rate limit hit; retry after ${retryAfterSeconds}s`);
    this.name = 'ZendeskRateLimitError';
  }
}

export class ZendeskPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZendeskPermissionError';
  }
}

export class ZendeskConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZendeskConflictError';
  }
}

export class ZendeskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZendeskValidationError';
  }
}

export async function mapErrorResponse(response: Response): Promise<Error> {
  const bodyText = await response.text();
  switch (response.status) {
    case 429: {
      const retryAfter = Number(response.headers.get('retry-after') ?? '60');
      return new ZendeskRateLimitError(retryAfter);
    }
    case 403:
      return new ZendeskPermissionError(`Permission denied (scope ∩ role insufficient): ${bodyText}`);
    case 409:
      return new ZendeskConflictError(`Conflict — resource changed since last read: ${bodyText}`);
    case 422:
      return new ZendeskValidationError(`Validation failed: ${bodyText}`);
    default:
      return new Error(`Zendesk API error ${response.status}: ${bodyText}`);
  }
}
