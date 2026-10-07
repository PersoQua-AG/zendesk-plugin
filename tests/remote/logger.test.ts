import { describe, it, expect, vi, afterEach } from 'vitest';
import { log } from '../../src/remote/logger.js';

afterEach(() => vi.restoreAllMocks());

function capture(fn: () => void): string {
  let out = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  fn();
  return out;
}

describe('redacting logger', () => {
  it('redacts bearer tokens and secret-shaped blobs from the message', () => {
    const secret = 'SECRETSHAPED0_A1b2C3d4E5f6G7h8I9j0K1l2'; // 24+ char secret-shaped
    const out = capture(() =>
      log({ outcome: 'applied', msg: `auth Bearer abc.DEF-123456 used with ${secret}` }),
    );
    expect(out).not.toContain('Bearer abc.DEF-123456');
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('emits a single valid JSON line preserving non-sensitive fields', () => {
    const out = capture(() => log({ outcome: 'ok', msg: 'done' }));
    expect(out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out.trim());
    // LogFields is msg + outcome and nothing else, and no caller in src/ passes more. This test
    // used to assert `tool` and `latencyMs` survived the round trip — fields the logger's type has
    // never had — so it proved a surface that does not exist. src/ is out of scope for #57.
    expect(parsed.outcome).toBe('ok');
    expect(parsed.msg).toBe('done');
  });
});
