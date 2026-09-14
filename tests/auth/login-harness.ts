// Shared fixture for the three zendesk_login suites. It held three wordlike-identical copies of
// freePort/config/deps/authorizationUrl and of the beforeEach/afterEach pair; the afterEach in
// particular is load-bearing — runLogin keeps its flow in module state, so a case that leaves a
// listener bound makes the NEXT case depend on the order it ran in.
import { expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { abortLoginFlow, type LoginDeps } from '../../src/tools/login.js';
import type { OAuthConfig } from '../../src/auth/oauth-flow.js';

export const SECRET = 'secret-xyz';

// Live bindings: re-pointed by the beforeEach below, read by every importing suite.
export let dataDir: string;
export let tokensPath: string;

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createHttpServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export function config(port: number): OAuthConfig {
  return { subdomain: 'acme', clientId: 'client-abc', clientSecret: SECRET, callbackPort: port, scopes: ['read', 'write'] };
}

export function deps(port: number, overrides: Partial<LoginDeps> = {}): LoginDeps {
  return { config: config(port), tokensPath, ...overrides };
}

export function authorizationUrl(text: string): URL {
  const raw = text.split(/\s+/).find((w) => w.startsWith('https://'));
  expect(raw, `no authorization URL in:\n${text}`).toBeDefined();
  return new URL(raw as string);
}

// What the user's browser does after approving, verbatim: a GET on the redirect_uri the
// authorization URL itself names.
export function redirect(url: URL, params: Record<string, string>): Promise<Response> {
  const target = new URL(url.searchParams.get('redirect_uri') as string);
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return fetch(target);
}

export async function hitCallback(port: number, query: string): Promise<void> {
  await fetch(`http://localhost:${port}/callback${query}`);
}

// Proof that nothing is left listening: the port binds again.
export async function rebind(port: number): Promise<void> {
  const probe = createHttpServer(() => {});
  await new Promise<void>((r) => probe.listen(port, r));
  await new Promise((r) => probe.close(r));
}

export function setupLoginHarness(prefix: string): void {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), prefix));
    tokensPath = join(dataDir, 'tokens.enc');
  });
  afterEach(() => {
    // Flow state is module-level: it must not leak into the next case, nor leave a listener bound.
    abortLoginFlow();
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
}
