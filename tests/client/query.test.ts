import { describe, it, expect } from 'vitest';
import { extractPath, runQuery } from '../../src/client/query.js';

describe('extractPath', () => {
  it('extracts a nested field by dot path', () => {
    const data = { ticket: { requester: { name: 'Ada' } } };
    expect(extractPath(data, 'ticket.requester.name')).toBe('Ada');
  });

  it('extracts an array element by index syntax', () => {
    const data = { comments: [{ id: 1 }, { id: 2 }] };
    expect(extractPath(data, 'comments[1].id')).toBe(2);
  });

  it('returns undefined for a missing path instead of throwing', () => {
    const data = { ticket: {} };
    expect(extractPath(data, 'ticket.requester.name')).toBeUndefined();
  });
});

describe('runQuery', () => {
  it('applies the comments_slim named preset', () => {
    const data = { comments: [{ id: 1, author_id: 9, public: true, body: 'hi', extra: 'noise' }] };
    expect(runQuery(data, 'comments_slim')).toEqual([{ id: 1, author_id: 9, public: true, body: 'hi' }]);
  });

  it('applies the ids_only named preset to an array', () => {
    const data = [{ id: 1 }, { id: 2 }];
    expect(runQuery(data, 'ids_only')).toEqual([1, 2]);
  });

  it('falls back to dot-path extraction when the query is not a known preset', () => {
    const data = { ticket: { status: 'open' } };
    expect(runQuery(data, 'ticket.status')).toBe('open');
  });

  it('comments_slim returns [] (not throw) when comments is missing or null', () => {
    expect(runQuery({}, 'comments_slim')).toEqual([]);
    expect(runQuery({ comments: null }, 'comments_slim')).toEqual([]);
    expect(runQuery(null, 'comments_slim')).toEqual([]);
  });
});
