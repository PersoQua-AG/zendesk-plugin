// Global test network guard (vitest setupFiles).
//
// Several login cases drive the REAL localhost callback listener and stub only the token exchange.
// Where a case forgets that stub, the code under test would POST to acme.zendesk.com — a host that
// exists — and the suite would either hang, or pass/fail on what the internet answered instead of
// on the code. That has happened. From here on a request to anything but loopback fails loudly and
// names the test that made it.
//
// Only the GLOBAL fetch is wrapped. A test that deliberately injects its own fetch (an fetchImpl
// dependency, or vi.stubGlobal) is untouched — that is a stub, not a network call.

const realFetch = globalThis.fetch;

// localhost, 127.0.0.0/8 and ::1 — everything a test may legitimately talk to.
function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function targetOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(targetOf(input));
  if (!isLoopback(url.hostname)) {
    return Promise.reject(
      new Error(
        `Blocked outbound request to ${url.origin} — tests must not touch the network. ` +
          'Stub the dependency (exchange/fetchImpl) instead.',
      ),
    );
  }
  return realFetch(input, init);
}) as typeof fetch;
