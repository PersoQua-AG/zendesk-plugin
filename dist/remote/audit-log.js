import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
// D3/A7: server-side write-audit retention window.
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
// Append-only JSONL write-audit log (REQ-10). Records who did what to which target with what
// outcome — never ticket bodies, never secrets, and the identity is hashed (not raw). prune()
// enforces the 90-day retention window; call it at startup and on a timer.
export class WriteAuditLog {
    filePath;
    constructor(filePath) {
        this.filePath = filePath;
        const dir = dirname(filePath);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
    }
    record(identity, tool, targetId, outcome) {
        const entry = { ts: Date.now(), identityHash: this.hash(identity), tool, targetId, outcome };
        appendFileSync(this.filePath, JSON.stringify(entry) + '\n', { mode: 0o600 });
    }
    prune(now = Date.now()) {
        if (!existsSync(this.filePath))
            return;
        const kept = readFileSync(this.filePath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .filter((line) => now - JSON.parse(line).ts <= RETENTION_MS);
        writeFileSync(this.filePath, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 });
    }
    hash(identity) {
        return createHash('sha256').update(`zendesk-user:${identity}`).digest('hex').slice(0, 16);
    }
}
