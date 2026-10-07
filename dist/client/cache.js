import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync, accessSync, constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { warnConfig } from '../util/warn-config.js';
import { errorCode } from '../util/error-code.js';
const HANDLE_PATTERN = /^[A-Za-z0-9_-]+$/;
// Cached payloads hold screened ticket PII, so the store must not grow unbounded. Entries expire
// after a fixed age (mtime-based) and the total on-disk size is capped; both are configurable.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
export class ResponseCache {
    resolvedDir;
    ttlMs;
    maxBytes;
    constructor(cacheDir, options = {}) {
        mkdirSync(cacheDir, { recursive: true });
        // mkdir succeeds on an EXISTING unwritable directory, so the first save() would throw EACCES
        // with the absolute path into tool output. Fail here instead: server.ts turns this into the
        // code-only degrade message. All three bits: sweep() reads the dir, save() writes it, and
        // neither can reach an entry without the traverse bit.
        this.resolvedDir = resolve(cacheDir);
        // Checked on the RESOLVED path, the one every other method addresses the store through: keeping
        // the raw spelling as a second representation let a relative cacheDir plus a process.chdir
        // desynchronise the guard from the traversal check that trusts it.
        accessSync(this.resolvedDir, constants.R_OK | constants.W_OK | constants.X_OK);
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    }
    save(toolName, data) {
        const handle = `${toolName}-${randomBytes(6).toString('hex')}`;
        const path = join(this.resolvedDir, `${handle}.json`);
        // The constructor's check goes stale: the disk fills, a quota bites, the volume remounts
        // read-only. Node's fs errors carry the absolute path and this one reaches the model, so
        // report the code and the remedy like the degrade path does, never the path.
        try {
            writeFileSync(path, JSON.stringify(data));
        }
        catch (err) {
            // A write that failed PARTWAY (ENOSPC, EDQUOT — writeFileSync loops on write(2)) leaves a
            // truncated file that nothing else unlinks, and it counts against maxBytes until its TTL
            // expires. Deliberately untested: every failure this suite can produce — EACCES, EISDIR,
            // EROFS — fails at open(2) and creates nothing, so no test here can tell this line apart
            // from its absence. Kept because the cleanup is unconditionally correct and two lines.
            rmSync(path, { force: true });
            throw new Error(`Caching the response failed (${errorCode(err)}). Make sure the extension's data ` +
                'directory is a writable directory with free space, then reload the extension.', { cause: err });
        }
        // Housekeeping, outside the write contract: the entry is on disk, so the caller must get its
        // handle even if the sweep fails. Announce it on stderr; the next save() sweeps again.
        try {
            this.sweep();
        }
        catch (err) {
            warnConfig(`Cache housekeeping failed (${errorCode(err)}); the cache may grow past its size cap.`);
        }
        return { handle, path };
    }
    load(handle) {
        const path = this.resolveHandlePath(handle);
        // An expired entry is treated as missing (and reaped) — never served stale PII.
        if (!existsSync(path) || this.isExpired(path)) {
            rmSync(path, { force: true });
            throw new Error(`Cache handle not found: ${handle}`);
        }
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    isExpired(path) {
        return Date.now() - statSync(path).mtimeMs > this.ttlMs;
    }
    // One sweep per write: drop expired entries, then evict oldest-first until the total on-disk
    // size is back under the cap. Cheap because a single MCP session holds few, small payloads.
    sweep() {
        const live = [];
        for (const name of readdirSync(this.resolvedDir)) {
            if (!name.endsWith('.json'))
                continue;
            const path = join(this.resolvedDir, name);
            const stat = statSync(path);
            if (Date.now() - stat.mtimeMs > this.ttlMs) {
                rmSync(path, { force: true });
                continue;
            }
            live.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
        }
        live.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
        let total = live.reduce((sum, e) => sum + e.size, 0);
        for (let i = 0; i < live.length && total > this.maxBytes; i++) {
            rmSync(live[i].path, { force: true });
            total -= live[i].size;
        }
    }
    // Reject anything that is not a plain handle, then confine the resolved path to
    // the cache dir — defense in depth against `../` traversal reading arbitrary files.
    resolveHandlePath(handle) {
        if (!HANDLE_PATTERN.test(handle)) {
            throw new Error(`Invalid cache handle: ${handle}`);
        }
        const path = resolve(this.resolvedDir, `${handle}.json`);
        if (path !== join(this.resolvedDir, `${handle}.json`) || !path.startsWith(this.resolvedDir + sep)) {
            throw new Error(`Invalid cache handle: ${handle}`);
        }
        return path;
    }
}
