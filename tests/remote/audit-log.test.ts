import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteAuditLog, RETENTION_MS } from '../../src/remote/audit-log.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function auditPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zd-audit-'));
  dirs.push(dir);
  return join(dir, 'audit', 'write-audit.jsonl');
}

function lines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

describe('WriteAuditLog', () => {
  it('records a shaped entry with a hashed identity and no PII or secret', () => {
    const path = auditPath();
    const audit = new WriteAuditLog(path);
    audit.record('alice@persoqua.de', 'zendesk_update_ticket', '42', 'applied');

    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('alice');
    expect(raw).not.toContain('persoqua');
    const entry = JSON.parse(lines(path)[0]);
    expect(entry).toMatchObject({ tool: 'zendesk_update_ticket', targetId: '42', outcome: 'applied' });
    expect(typeof entry.identityHash).toBe('string');
    expect(entry.identityHash).not.toContain('alice');
    expect(typeof entry.ts).toBe('number');
  });

  it('prunes entries older than the 90-day retention window', () => {
    const path = auditPath();
    const audit = new WriteAuditLog(path);
    audit.record('A', 'zendesk_update_ticket', '1', 'applied');
    expect(lines(path)).toHaveLength(1);

    audit.prune(Date.now()); // within window → kept
    expect(lines(path)).toHaveLength(1);

    audit.prune(Date.now() + RETENTION_MS + 1); // past window → dropped
    expect(lines(path)).toHaveLength(0);
  });

  it('skips a torn JSONL line without throwing, keeps a fresh line, drops an expired one', () => {
    const path = auditPath();
    const audit = new WriteAuditLog(path);
    const fresh = JSON.stringify({ ts: Date.now(), identityHash: 'h', tool: 'zendesk_update_ticket', targetId: '1', outcome: 'applied' });
    const expired = JSON.stringify({ ts: Date.now() - RETENTION_MS - 1, identityHash: 'h', tool: 'zendesk_update_ticket', targetId: '2', outcome: 'applied' });
    // A crash mid-append leaves a torn (non-JSON) line.
    writeFileSync(path, `${fresh}\n${expired}\n{"ts":123,"tool":"tor`);

    expect(() => audit.prune()).not.toThrow();
    const kept = lines(path);
    expect(kept).toHaveLength(1);
    expect(JSON.parse(kept[0])).toMatchObject({ targetId: '1' }); // only the fresh line survives
  });
});
