import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/server.js';

// resolveOrDegrade (src/server.ts:46) keeps the server alive with an EMPTY subdomain, so the http
// client's base URL is literally "https://.zendesk.com/api/v2". Nothing may ever reach that host.
// The guard is ordering, not string checking: both request paths await getAccessToken() BEFORE
// fetch (src/client/http-client.ts:53, :83), and the degraded TokenProvider always rejects
// (src/server.ts:63). This pins that ordering — reorder either path and these turn red.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function degradedEnv(): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'zd-degraded-'));
  dirs.push(dataDir);
  // Client id present, required subdomain and secret missing → degraded, not throwing.
  return { ZENDESK_OAUTH_CLIENT_ID: 'client-abc', CLAUDE_PLUGIN_DATA: dataDir };
}

function spyFetch() {
  return vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
}

describe('an incompletely configured server never reaches the network', () => {
  it('rejects a JSON request at the token boundary, naming the empty field, without fetching', async () => {
    const fetchImpl = spyFetch();
    const { ctx } = createServer(degradedEnv(), { fetchImpl });
    await expect(ctx.httpClient.request('/users/me.json')).rejects.toThrow(/zendesk_subdomain/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects the binary upload path the same way, without fetching', async () => {
    const fetchImpl = spyFetch();
    const { ctx } = createServer(degradedEnv(), { fetchImpl });
    await expect(
      ctx.httpClient.requestUpload('/uploads.json', new Uint8Array([1, 2, 3]), 'text/plain'),
    ).rejects.toThrow(/zendesk_subdomain/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never puts the degraded empty-subdomain host into the failure message', async () => {
    const { ctx } = createServer(degradedEnv(), { fetchImpl: spyFetch() });
    const err = await ctx.httpClient.request('/users/me.json').catch((e: unknown) => e as Error);
    expect(err.message).not.toContain('.zendesk.com');
  });
});
