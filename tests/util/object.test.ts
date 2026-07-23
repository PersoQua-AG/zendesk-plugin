// tests/util/object.test.ts
import { describe, it, expect } from 'vitest';
import { stripUndefined } from '../../src/util/object.js';

describe('stripUndefined', () => {
  it('drops undefined-valued keys and keeps defined ones (incl. falsy values)', () => {
    expect(stripUndefined({ a: 1, b: undefined, c: 0, d: '', e: false })).toEqual({ a: 1, c: 0, d: '', e: false });
  });

  it('preserves null (an explicit, meaningful value)', () => {
    expect(stripUndefined({ a: null, b: undefined })).toEqual({ a: null });
  });

  it('returns an empty object when every value is undefined', () => {
    expect(stripUndefined({ a: undefined, b: undefined })).toEqual({});
  });
});
