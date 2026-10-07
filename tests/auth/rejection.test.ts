import { describe, it, expect } from 'vitest';
import { rejection } from './rejection.js';

// The point of the helper is the message it produces when it is DISAPPOINTED (#57). The old cast
// produced no message at all: a resolved promise flowed on as an `Error` and the next line died on
// a TypeError, which names the test's own code and not the expectation that failed.
describe('rejection()', () => {
  it('returns the Error a rejected promise carries', async () => {
    const err = await rejection('the subject', Promise.reject(new TypeError('boom')));
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe('boom');
  });

  it('names the missing rejection when the promise resolves, and does not die on a TypeError', async () => {
    const outcome = await rejection('the subject', Promise.resolve('fine')).catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('expected the subject to reject, and it resolved');
    expect((outcome as Error).message).not.toContain('Cannot read properties');
  });

  // What the cast silently permitted: a promise rejecting with a string. `err.message` on it is
  // undefined, so every assertion below the cast compared undefined against the expected text.
  it('names a rejection that is not an Error rather than narrowing it to one', async () => {
    const outcome = await rejection('the subject', Promise.reject('a bare string')).catch((e: unknown) => e);
    expect((outcome as Error).message).toBe('expected the subject to reject with an Error, got string: a bare string');
  });

  // A resolved `undefined` is the exact shape the old cast handled worst: `undefined as Error`,
  // then `.message` on undefined. It must be the resolved-case message, not a TypeError.
  it('treats a promise resolving undefined as a missing rejection, not as an Error', async () => {
    const outcome = await rejection('the subject', Promise.resolve(undefined)).catch((e: unknown) => e);
    expect((outcome as Error).message).toBe('expected the subject to reject, and it resolved');
  });
});
