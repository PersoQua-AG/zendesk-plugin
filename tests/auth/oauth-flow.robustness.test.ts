import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { waitForAuthorizationCode } from '../../src/auth/oauth-flow.js';
import { freePort } from './login-harness.js';

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(() => {});
    server.listen(port, () => resolve(server));
  });
}

// Two /callback requests written into ONE socket, so the listener sees the replay before it can
// close — deterministic where two parallel fetches would race. Retries until the listener is bound.
async function pipelineTwoCallbacks(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = connect(port, 'localhost', () => {
        socket.write(
          'GET /callback?state=state&code=first HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n' +
            'GET /callback?state=state&code=second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
        );
        socket.resume(); // drain both responses, otherwise the socket never sees the server's FIN
      });
      socket.on('error', () => resolve(false));
      socket.on('close', () => resolve(socket.bytesRead > 0));
    });
    if (connected) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('callback listener never came up');
}

describe('waitForAuthorizationCode robustness', () => {
  it('rejects (does not throw uncaught) when the callback port is already in use', async () => {
    const port = freePort();
    const blocker = await listenOn(port);
    try {
      await expect(waitForAuthorizationCode(port, 'state', 5_000)).rejects.toThrow(/server error/i);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  // The browser can replay /callback (refresh, prefetch, a retried request on the same keep-alive
  // socket). Only the first one may settle the flow: a second must not overwrite the accepted code
  // or reject an already-resolved promise. Pipelined on ONE socket so both requests reach the
  // listener before it closes — no race, no timing assumption.
  it('ignores a replayed callback and keeps the first code', async () => {
    const port = freePort();
    const pending = waitForAuthorizationCode(port, 'state', 10_000);
    await pipelineTwoCallbacks(port);

    await expect(pending).resolves.toEqual({ code: 'first', redirectUri: `http://localhost:${port}/callback` });
  });

  it('rejects and closes the server when no callback arrives before the timeout', async () => {
    const port = freePort();
    await expect(waitForAuthorizationCode(port, 'state', 30)).rejects.toThrow(/timed out/i);
    // The port must be free again after the timeout closed the server.
    const reuse = await listenOn(port);
    await new Promise<void>((r) => reuse.close(() => r()));
  });
});
