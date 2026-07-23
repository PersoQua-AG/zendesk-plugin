import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { waitForAuthorizationCode } from '../../src/auth/oauth-flow.js';

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(() => {});
    server.listen(port, () => resolve(server));
  });
}

describe('waitForAuthorizationCode robustness', () => {
  it('rejects (does not throw uncaught) when the callback port is already in use', async () => {
    const blocker = await listenOn(18990);
    try {
      await expect(waitForAuthorizationCode(18990, 'state', 5_000)).rejects.toThrow(/server error/i);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('rejects and closes the server when no callback arrives before the timeout', async () => {
    await expect(waitForAuthorizationCode(18991, 'state', 30)).rejects.toThrow(/timed out/i);
    // The port must be free again after the timeout closed the server.
    const reuse = await listenOn(18991);
    await new Promise<void>((r) => reuse.close(() => r()));
  });
});
