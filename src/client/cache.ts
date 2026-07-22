import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface CacheEntry {
  handle: string;
  path: string;
}

export class ResponseCache {
  constructor(private readonly cacheDir: string) {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  }

  save(toolName: string, data: unknown): CacheEntry {
    const handle = `${toolName}-${randomBytes(6).toString('hex')}`;
    const path = join(this.cacheDir, `${handle}.json`);
    writeFileSync(path, JSON.stringify(data));
    return { handle, path };
  }

  load(handle: string): unknown {
    const path = join(this.cacheDir, `${handle}.json`);
    if (!existsSync(path)) {
      throw new Error(`Cache handle not found: ${handle}`);
    }
    return JSON.parse(readFileSync(path, 'utf8'));
  }
}
