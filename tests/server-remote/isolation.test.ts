import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { sessionCacheDir, createAuditObserver } from '../../src/remote/session-manager.js';
import { ResponseCache } from '../../src/client/cache.js';
import { WriteAuditLog } from '../../src/remote/audit-log.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'zd-iso-'));
  dirs.push(d);
  return d;
}

describe('per-user session isolation', () => {
  it('derives a distinct cache dir per identity, same dir for same identity', () => {
    const dataDir = tmp();
    const u1 = sessionCacheDir(dataDir, 'zendesk:1');
    const u2 = sessionCacheDir(dataDir, 'zendesk:2');
    expect(u1).not.toBe(u2);
    expect(sessionCacheDir(dataDir, 'zendesk:1')).toBe(u1);
    expect(u1.startsWith(join(dataDir, 'cache'))).toBe(true);
  });

  it('U2 cannot load a cache handle minted in U1 cache dir', () => {
    const dataDir = tmp();
    const c1 = new ResponseCache(sessionCacheDir(dataDir, 'zendesk:1'));
    const c2 = new ResponseCache(sessionCacheDir(dataDir, 'zendesk:2'));
    const { handle } = c1.save('zendesk_search', { secret: 'U1-only' });
    expect(c1.load(handle)).toEqual({ secret: 'U1-only' });
    expect(() => c2.load(handle)).toThrow(/not found/i);
  });
});

describe('write-audit observer', () => {
  const callMsg = (name: string, args: Record<string, unknown>): JSONRPCMessage => ({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const okResult = (text: string): JSONRPCMessage => ({
    jsonrpc: '2.0',
    id: 7,
    result: { content: [{ type: 'text', text }] },
  });

  it('records one entry per write with the hashed identity and derived target', () => {
    const path = join(tmp(), 'audit.jsonl');
    const audit = new WriteAuditLog(path);
    const obs = createAuditObserver(audit, 'zendesk:1');

    obs.onInbound(callMsg('zendesk_update_ticket', { id: 42 }));
    obs.onOutbound(okResult('Updated ticket #42'));

    const entries = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tool: 'zendesk_update_ticket', targetId: '42', outcome: 'applied' });
    expect(readFileSync(path, 'utf8')).not.toContain('zendesk:1'); // identity hashed, not raw
  });

  it('classifies a conflict result and ignores read tools', () => {
    const path = join(tmp(), 'audit.jsonl');
    const audit = new WriteAuditLog(path);
    const obs = createAuditObserver(audit, 'zendesk:9');

    obs.onInbound(callMsg('zendesk_search', { query: 'x' })); // read → not audited
    obs.onOutbound(okResult('results'));
    obs.onInbound(callMsg('zendesk_update_ticket', { ticket_id: 5 }));
    obs.onOutbound(okResult('Conflict: ticket changed since read'));

    const entries = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tool: 'zendesk_update_ticket', targetId: '5', outcome: 'conflict' });
  });
});
