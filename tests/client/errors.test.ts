import { describe, it, expect } from 'vitest';
import {
  mapErrorResponse,
  parseRetryAfter,
  ZendeskApiError,
  ZendeskRateLimitError,
  ZendeskPermissionError,
  ZendeskConflictError,
  ZendeskValidationError,
} from '../../src/client/errors.js';

describe('mapErrorResponse', () => {
  it('maps 429 to ZendeskRateLimitError with the Retry-After seconds', async () => {
    const response = new Response('rate limited', { status: 429, headers: { 'Retry-After': '30' } });
    const error = await mapErrorResponse(response);
    expect(error).toBeInstanceOf(ZendeskRateLimitError);
    expect((error as ZendeskRateLimitError).retryAfterSeconds).toBe(30);
  });

  it('maps 403 to ZendeskPermissionError mentioning scope ∩ role', async () => {
    const response = new Response('forbidden', { status: 403 });
    const error = await mapErrorResponse(response);
    expect(error).toBeInstanceOf(ZendeskPermissionError);
    expect(error.message).toMatch(/scope.*role/i);
  });

  it('maps 409 to ZendeskConflictError (optimistic concurrency)', async () => {
    const response = new Response('conflict', { status: 409 });
    const error = await mapErrorResponse(response);
    expect(error).toBeInstanceOf(ZendeskConflictError);
  });

  it('maps 422 to ZendeskValidationError', async () => {
    const response = new Response('validation failed', { status: 422 });
    const error = await mapErrorResponse(response);
    expect(error).toBeInstanceOf(ZendeskValidationError);
  });

  it('maps any other status to a generic Error including the status and body', async () => {
    const response = new Response('server exploded', { status: 500 });
    const error = await mapErrorResponse(response);
    expect(error.message).toContain('500');
    expect(error.message).toContain('server exploded');
  });

  it('all typed errors extend ZendeskApiError and carry their status', async () => {
    for (const [status, ctor] of [
      [429, ZendeskRateLimitError],
      [403, ZendeskPermissionError],
      [409, ZendeskConflictError],
      [422, ZendeskValidationError],
    ] as const) {
      const error = await mapErrorResponse(new Response('x', { status }));
      expect(error).toBeInstanceOf(ZendeskApiError);
      expect((error as ZendeskApiError).status).toBe(status);
      expect(error).toBeInstanceOf(ctor);
    }
  });
});

describe('parseRetryAfter', () => {
  it('parses integer seconds', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter('  0 ')).toBe(0);
  });

  it('computes a delta from an RFC HTTP-date', () => {
    const now = () => Date.parse('2026-07-22T12:00:00Z');
    expect(parseRetryAfter('Wed, 22 Jul 2026 12:00:45 GMT', now)).toBe(45);
  });

  it('never returns a negative delay for a past HTTP-date', () => {
    const now = () => Date.parse('2026-07-22T12:00:00Z');
    expect(parseRetryAfter('Wed, 22 Jul 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('falls back to 60 for garbage or missing headers (never NaN)', () => {
    expect(parseRetryAfter('soon-ish')).toBe(60);
    expect(parseRetryAfter('')).toBe(60);
    expect(parseRetryAfter(null)).toBe(60);
    expect(Number.isNaN(parseRetryAfter('not-a-date'))).toBe(false);
  });
});
