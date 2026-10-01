import { describe, it, expect, afterEach } from 'vitest';
import { startCallbackListener, type CallbackListener } from '../../src/auth/oauth-flow.js';
import { createSetupRoute, newSetupToken, setupUrl, type SetupValues } from '../../src/tools/setup.js';
import { connect, type Socket } from 'node:net';
import { freePort } from '../auth/login-harness.js';

// The first-run page is served from the callback listener itself, so these cases drive a REAL listener
// over a real socket: the guards are about HTTP (method, origin, a token in the query string, a body
// that could be any size), and a direct call to the handler would check none of that.

const TOKEN = newSetupToken();
const VALUES: SetupValues = {
  ZENDESK_SUBDOMAIN: 'acme',
  ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
  ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
};
const AUTHORIZED = 'https://acme.zendesk.com/oauth/authorizations/new?state=s1';

const open: CallbackListener[] = [];
afterEach(() => {
  for (const listener of open.splice(0)) listener.close();
});

interface Served {
  port: number;
  submitted: SetupValues[];
  get: (query?: string) => Promise<Response>;
  post: (body: string, init?: { origin?: string | null; method?: string }) => Promise<Response>;
}

async function serve(submit?: (values: SetupValues) => string): Promise<Served> {
  const port = freePort();
  const submitted: SetupValues[] = [];
  const route = createSetupRoute({
    port,
    token: TOKEN,
    submit:
      submit ??
      ((values) => {
        submitted.push(values);
        return AUTHORIZED;
      }),
  });
  const listener = await startCallbackListener(port, 'state-1', 5_000, route);
  open.push(listener);
  // The flow's own promise is never awaited here; attached so a close() is not an unhandled rejection.
  void listener.promise.catch(() => {});
  return {
    port,
    submitted,
    get: (query = `?t=${TOKEN}`) => fetch(`http://127.0.0.1:${port}/setup${query}`, { redirect: 'manual' }),
    // redirect: 'manual' throughout — a followed 303 would send the suite to the real Zendesk.
    post: (body, init = {}) =>
      fetch(`http://127.0.0.1:${port}/setup?t=${TOKEN}`, {
        method: init.method ?? 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(init.origin === null ? {} : { Origin: init.origin ?? `http://127.0.0.1:${port}` }),
        },
        body,
      }),
  };
}

// A socket, not fetch(): the three cases below are about what arrives on the wire — a body that is still
// being sent, a chunked one, and a second request that overlaps the first. fetch() cannot express any of
// them, and undici's connection reuse would hide the overlap.
const sockets: Socket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
});

function raw(port: number): { send: (chunk: string) => void; response: Promise<string> } {
  const socket = connect(port, '127.0.0.1');
  sockets.push(socket);
  let answer = '';
  const response = new Promise<string>((done) => {
    socket.on('data', (chunk) => {
      answer += String(chunk);
      // The status line is all these cases read, and every answer here is short.
      if (answer.includes('\r\n\r\n')) done(answer);
    });
    socket.on('close', () => done(answer));
  });
  const ready = new Promise<void>((connected) => socket.once('connect', () => connected()));
  return {
    send: (chunk) => void ready.then(() => socket.write(chunk)),
    response,
  };
}

const status = (answer: string): number => Number(answer.split(' ')[1]);

const postHead = (port: number, token: string, length: number, extra = ''): string =>
  `POST /setup?t=${token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\n` +
  `Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${length}\r\n${extra}\r\n`;

const form = (values: Partial<Record<string, string>>): string =>
  new URLSearchParams(values as Record<string, string>).toString();

const goodForm = form({ subdomain: 'acme', client_id: 'client-abc', client_secret: 'secret-xyz' });

describe('the first-run setup page', () => {
  it('names the exact place in Zendesk and the exact values to enter there', async () => {
    const served = await serve();
    const page = await (await served.get()).text();

    expect(page).toContain('Apps und Integrationen → APIs → OAuth-Clients');
    expect(page).toContain('OAuth-Client hinzufügen');
    // The redirect URL is `localhost`, because that is what the token exchange sends to Zendesk
    // (src/auth/oauth-flow.ts redirectUri) and what the customer must therefore register.
    expect(page).toContain(`http://localhost:${served.port}/callback`);
    expect(page).toContain('Art von Client');
    expect(page).toContain('vertraulich');
    expect(page).toContain('Zugriffsart');
    expect(page).toContain('leer lassen');
    expect(page).toContain('read write');
    expect(page).toContain('name="subdomain"');
    expect(page).toContain('name="client_id"');
    expect(page).toContain('type="password"');
  });

  it('is reachable only with its own one-time token', async () => {
    const served = await serve();
    expect((await served.get('')).status).toBe(404);
    expect((await served.get('?t=')).status).toBe(404);
    expect((await served.get(`?t=${newSetupToken()}`)).status).toBe(404);
    // A token of a different LENGTH must not crash the comparison either.
    expect((await served.get('?t=short')).status).toBe(404);
    expect((await served.get()).status).toBe(200);
  });

  it('takes the three values only by POST', async () => {
    const served = await serve();
    const refused = await served.post(goodForm, { method: 'PUT' });
    expect(refused.status).toBe(405);
    expect(refused.headers.get('allow')).toBe('GET, POST');
    expect(served.submitted).toEqual([]);
  });

  // The posture, in one line: a request that SENDS an Origin must send ours, and one that sends none is
  // let through — `Origin` is a control a browser applies to itself, so its absence means the caller is
  // not a browser, and against a non-browser caller the control is the one-time token, not a header that
  // caller writes itself.
  it('refuses a POST from a foreign origin, and lets one with no Origin through', async () => {
    const served = await serve();
    expect((await served.post(goodForm, { origin: 'https://evil.example.com' })).status).toBe(403);
    expect(served.submitted).toEqual([]);
    expect((await served.post(goodForm, { origin: null })).status).toBe(303);
    expect(served.submitted).toHaveLength(1);
  });

  it('accepts the page’s own origin in every spelling the browser may use', async () => {
    for (const origin of ['127.0.0.1', 'localhost', '[::1]'] as const) {
      const served = await serve();
      const answer = await served.post(goodForm, { origin: `http://${origin}:${served.port}` });
      expect(answer.status, origin).toBe(303);
    }
  });

  it('stores the values and sends the browser straight on to Zendesk', async () => {
    const served = await serve();
    const answer = await served.post(form({ subdomain: '  ACME  ', client_id: ' client-abc ', client_secret: ' secret-xyz ' }));

    expect(answer.status).toBe(303);
    expect(answer.headers.get('location')).toBe(AUTHORIZED);
    // Trimmed, because the values arrive by copy-paste; the subdomain keeps the case it was given, as
    // resolveAuthConfig has always accepted it.
    expect(served.submitted).toEqual([{ ...VALUES, ZENDESK_SUBDOMAIN: 'ACME' }]);
  });

  it('spends the token on a successful submission, so nothing can be replayed', async () => {
    const served = await serve();
    expect((await served.post(goodForm)).status).toBe(303);
    expect((await served.post(goodForm)).status).toBe(404);
    expect((await served.get()).status).toBe(404);
    expect(served.submitted).toHaveLength(1);
  });

  it.each([
    ['an empty subdomain', form({ subdomain: '', client_id: 'c', client_secret: 's' }), 'Subdomain besteht nur aus'],
    ['a pasted host as the subdomain', form({ subdomain: 'echo-me.zendesk.com', client_id: 'c', client_secret: 's' }), 'Subdomain besteht nur aus'],
    ['a missing client id', form({ subdomain: 'acme', client_secret: 's' }), 'Client-ID fehlt'],
    ['a blank client secret', form({ subdomain: 'acme', client_id: 'c', client_secret: '   ' }), 'Client-Secret fehlt'],
    ['a control character in the secret', form({ subdomain: 'acme', client_id: 'c', client_secret: 'a\nb' }), 'Client-Secret fehlt'],
  ])('refuses %s and says which field, without echoing it', async (_label, body, expected) => {
    const served = await serve();
    const answer = await served.post(body);
    const page = await answer.text();

    expect(answer.status).toBe(400);
    expect(page).toContain(expected);
    expect(served.submitted).toEqual([]);
    // Nothing submitted is reflected back: the subdomain rule interpolates the value it rejected, and
    // this page does not repeat it — a value in an HTML response is a value in a browser cache. (The
    // page's own example names acme.zendesk.com, which is why the probe above is a distinctive value.)
    expect(page).not.toContain('echo-me');
    expect(page).not.toMatch(/value="/);
    // The token survives a typo, so the person can correct it on the page they are already on.
    expect((await served.post(goodForm)).status).toBe(303);
  });

  // The socket is dropped rather than answered: this is not a person pasting too much, it is an
  // unauthenticated local caller making the server read until it runs out of memory, and the cheapest
  // true answer to that is to stop reading. A form is a few hundred bytes.
  it('drops a body too large to be a form, and stores nothing', async () => {
    const served = await serve();
    await expect(
      served.post(form({ subdomain: 'acme', client_id: 'c', client_secret: 'x'.repeat(5000) })),
    ).rejects.toThrow();
    expect(served.submitted).toEqual([]);
    // The listener is still there afterwards: one abusive request does not end a pending setup.
    expect((await served.get()).status).toBe(200);
  });

  it('says nothing about itself when storing the values fails', async () => {
    const served = await serve(() => {
      throw new Error(`keychain refused while writing secret-xyz for acme`);
    });
    const answer = await served.post(goodForm);
    const body = await answer.text();

    expect(answer.status).toBe(500);
    expect(body).not.toContain('secret-xyz');
    expect(body).not.toContain('keychain');
    expect(answer.headers.get('location')).toBeNull();
  });

  it('shares the listener with the callback, which still settles the flow', async () => {
    const port = freePort();
    const listener = await startCallbackListener(
      port,
      'state-1',
      5_000,
      createSetupRoute({ port, token: TOKEN, submit: () => AUTHORIZED }),
    );
    open.push(listener);

    expect((await fetch(`http://127.0.0.1:${port}/setup?t=${TOKEN}`, { redirect: 'manual' })).status).toBe(200);
    await fetch(`http://127.0.0.1:${port}/callback?state=state-1&code=after-setup`);

    await expect(listener.promise).resolves.toMatchObject({ code: 'after-setup' });
  });

  it('builds a URL on the address it is given, with the token in it', () => {
    const url = new URL(setupUrl('127.0.0.1', 8976, TOKEN));
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe('8976');
    expect(url.pathname).toBe('/setup');
    expect(url.searchParams.get('t')).toBe(TOKEN);
    // 32 random bytes, base64url: not guessable by a local process in the window the page is open.
    expect(TOKEN).toMatch(/^[\w-]{43}$/);
    // And on the other family when that is the one that bound (#68 B2).
    expect(new URL(setupUrl('[::1]', 8976, TOKEN)).hostname).toBe('[::1]');
  });

  // GATE-GAP 10, the content type. The page posts a form; anything else is a caller that has
  // misunderstood it, and the honest answer is the same 400 a bad field gets — not a stored value.
  it('refuses a body that is not a form, and stores nothing', async () => {
    const served = await serve();
    const answer = await fetch(`http://127.0.0.1:${served.port}/setup?t=${TOKEN}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${served.port}` },
      body: JSON.stringify(VALUES),
    });
    expect(answer.status).toBe(400);
    expect(served.submitted).toEqual([]);
  });

  // A chunked body has no Content-Length, and the reader was rewritten to an async iteration over the
  // request: this is the case that says the rewrite reads a dechunked body and not the frames.
  it('reads a chunked body, which carries no Content-Length', async () => {
    const served = await serve();
    const body = goodForm;
    const half = Math.ceil(body.length / 2);
    const socket = raw(served.port);
    socket.send(postHead(served.port, TOKEN, 0, 'Transfer-Encoding: chunked\r\n').replace(/Content-Length: 0\r\n/, ''));
    socket.send(`${half.toString(16)}\r\n${body.slice(0, half)}\r\n`);
    socket.send(`${(body.length - half).toString(16)}\r\n${body.slice(half)}\r\n0\r\n\r\n`);

    expect(status(await socket.response)).toBe(303);
    expect(served.submitted).toEqual([VALUES]);
  });

  // GATE-GAP 10 and the defect the first attempt at it introduced. Two POSTs overlap: one declares its
  // length, sends eight bytes and waits; the other arrives complete. WHICH of them wins is the whole
  // question, so this case gives them different values and names the winner — a sorted [303, 404] would
  // have accepted the losing outcome as correct, and did.
  //
  // It must be the one that COMPLETES. A marker taken when a request arrives hands the single use to
  // whoever starts first, which is a caller that stalls on purpose: the person's real submission is
  // refused and the stall stores its own client.
  it('gives the single use to the submission that completes, not the one that started first', async () => {
    const served = await serve();
    const mine = goodForm;
    const theirs = form({ subdomain: 'attacker', client_id: 'evil-id', client_secret: 'evil-secret' });

    const stalled = raw(served.port);
    stalled.send(postHead(served.port, TOKEN, theirs.length));
    stalled.send(theirs.slice(0, 8));
    // The stalled request is now inside the handler, waiting for the rest of its body.
    await new Promise((settle) => setTimeout(settle, 50));

    // The person's submission, complete, while the other one waits.
    const completed = await served.post(mine);
    expect(completed.status).toBe(303);
    expect(completed.headers.get('location')).toBe(AUTHORIZED);

    stalled.send(theirs.slice(8));

    expect(status(await stalled.response)).toBe(404);
    // One submission, and it is the right one: nothing from the stalled request was stored and nothing
    // was redirected anywhere near it.
    expect(served.submitted).toEqual([VALUES]);
  });
});
