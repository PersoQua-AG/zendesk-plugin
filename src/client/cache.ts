import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

// TODO(M8): eviction/TTL

const HANDLE_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface CacheEntry {
  handle: string;
  path: string;
}

export class ResponseCache {
  private readonly resolvedDir: string;

  constructor(private readonly cacheDir: string) {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    this.resolvedDir = resolve(cacheDir);
  }

  save(toolName: string, data: unknown): CacheEntry {
    const handle = `${toolName}-${randomBytes(6).toString('hex')}`;
    const path = join(this.cacheDir, `${handle}.json`);
    writeFileSync(path, JSON.stringify(data));
    return { handle, path };
  }

  load(handle: string): unknown {
    const path = this.resolveHandlePath(handle);
    if (!existsSync(path)) {
      throw new Error(`Cache handle not found: ${handle}`);
    }
    return JSON.parse(readFileSync(path, 'utf8'));
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
