import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

const HANDLE_PATTERN = /^[A-Za-z0-9_-]+$/;

// Cached payloads hold screened ticket PII, so the store must not grow unbounded. Entries expire
// after a fixed age (mtime-based) and the total on-disk size is capped; both are configurable.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

export interface CacheEntry {
  handle: string;
  path: string;
}

export interface ResponseCacheOptions {
  ttlMs?: number;
  maxBytes?: number;
}

export class ResponseCache {
  private readonly resolvedDir: string;
  private readonly ttlMs: number;
  private readonly maxBytes: number;

  constructor(private readonly cacheDir: string, options: ResponseCacheOptions = {}) {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    this.resolvedDir = resolve(cacheDir);
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  save(toolName: string, data: unknown): CacheEntry {
    const handle = `${toolName}-${randomBytes(6).toString('hex')}`;
    const path = join(this.cacheDir, `${handle}.json`);
    writeFileSync(path, JSON.stringify(data));
    this.sweep();
    return { handle, path };
  }

  load(handle: string): unknown {
    const path = this.resolveHandlePath(handle);
    // An expired entry is treated as missing (and reaped) — never served stale PII.
    if (!existsSync(path) || this.isExpired(path)) {
      rmSync(path, { force: true });
      throw new Error(`Cache handle not found: ${handle}`);
    }
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  private isExpired(path: string): boolean {
    return Date.now() - statSync(path).mtimeMs > this.ttlMs;
  }

  // One sweep per write: drop expired entries, then evict oldest-first until the total on-disk
  // size is back under the cap. Cheap because a single MCP session holds few, small payloads.
  private sweep(): void {
    const live: { path: string; mtimeMs: number; size: number }[] = [];
    for (const name of readdirSync(this.cacheDir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.cacheDir, name);
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
  private resolveHandlePath(handle: string): string {
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
