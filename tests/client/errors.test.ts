import { describe, it, expect } from 'vitest';
import {
  mapErrorResponse,
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
});
