import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionCacheDir } from '../../src/remote/session-manager.js';
import { modeBitsIgnored } from '../setup/mode-bits.js';
import { startRemote, zendeskMock } from './harness.js';

const IDENTITY = 'zendesk:1';
const dirs: string[] = [];
const unusable: string[] = [];

afterEach(() => {
  for (const d of unusable.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* best effort */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The per-identity cache dir EXISTS but is not writable, which is the case the stdio path degrades
// on (server.ts, openCacheOrDegrade) and the remote path used to die on.
function unusableCacheDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-remote-rocache-'));
  dirs.push(dataDir);
  const cacheDir = sessionCacheDir(dataDir, IDENTITY);
  mkdirSync(cacheDir, { recursive: true });
  chmodSync(cacheDir, 0o500);
  unusable.push(cacheDir);
  return dataDir;
}

// chmod is not enforced for root, so the directory would stay writable and prove nothing.
describe.skipIf(modeBitsIgnored)('a remote session whose cache directory cannot be used', () => {
  it('completes initialize and still serves the tool surface', async () => {
    const dataDir = unusableCacheDataDir();
    const harness = await startRemote(zendeskMock({}), IDENTITY, true, { ZENDESK_DATA_DIR: dataDir });
    expect(await harness.toolNames()).toContain('zendesk_get_me');
    await harness.dispose();
  });

  it('logs the errno code and never the directory path', async () => {
    const dataDir = unusableCacheDataDir();
    const lines: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
    try {
      const harness = await startRemote(zendeskMock({}), IDENTITY, true, { ZENDESK_DATA_DIR: dataDir });
      await harness.dispose();
    } finally {
      stderr.mockRestore();
    }
    const logged = lines.join('');
    expect(logged).toContain('EACCES');
    expect(logged).not.toContain(dataDir);
    expect(logged).not.toMatch(/\bat .*\.(ts|js):\d+/);
  });
});
