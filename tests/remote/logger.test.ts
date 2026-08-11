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
      log({ tool: 'zendesk_update_ticket', outcome: 'applied', msg: `auth Bearer abc.DEF-123456 used with ${secret}` }),
    );
    expect(out).not.toContain('Bearer abc.DEF-123456');
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('emits a single valid JSON line preserving non-sensitive fields', () => {
    const out = capture(() => log({ tool: 'zendesk_report', outcome: 'ok', latencyMs: 12, msg: 'done' }));
    expect(out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out.trim());
    expect(parsed.tool).toBe('zendesk_report');
    expect(parsed.outcome).toBe('ok');
    expect(parsed.latencyMs).toBe(12);
  });
});
