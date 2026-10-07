import { describe, it, expect } from 'vitest';
import { rejection } from './rejection.js';

// The point of the helper is the message it produces when it is DISAPPOINTED (#57). The old cast
// produced no message at all: a resolved promise flowed on as an `Error` and the next line died on
// a TypeError, which names the test's own code and not the expectation that failed. So each case
// below reads the helper's own rejection — through the helper itself, which is the only narrowing
// in this file and the reason no `as Error` appears in it.
const disappointed = (p: Promise<unknown>): Promise<Error> =>
  rejection('rejection() itself', rejection('the subject', p));

describe('rejection()', () => {
  it('returns the Error a rejected promise carries', async () => {
    const err = await rejection('the subject', Promise.reject(new TypeError('boom')));
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe('boom');
  });

  // `undefined` is the exact shape the old cast handled worst — `undefined as Error`, then
  // `.message` on undefined — so it is the resolved value this case uses.
  it('names the missing rejection when the promise resolves, and does not die on a TypeError', async () => {
    const outcome = await disappointed(Promise.resolve(undefined));
    expect(outcome.message).toBe('expected the subject to reject, and it resolved');
  });

  // What the cast silently permitted: a promise rejecting with a string. `err.message` on it is
  // undefined, so every assertion below the cast compared undefined against the expected text.
  it('names a rejection that is not an Error rather than narrowing it to one', async () => {
    const outcome = await disappointed(Promise.reject('a bare string'));
    expect(outcome.message).toBe('expected the subject to reject with an Error, got string: a bare string');
  });
});
