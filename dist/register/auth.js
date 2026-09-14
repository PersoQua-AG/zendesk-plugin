import { z } from 'zod';
import { toText } from '../tools/result.js';
import { runLogin } from '../tools/login.js';
// Login deps are a second parameter, not a ToolContext field: LoginDeps carries the OAuth client
// secret, and none of the other 64 registrars has any business reaching it through the shared ctx.
// Passing it here also makes the local-vs-remote mode switch visible at the call site in server.ts.
//
// The login flow binds a LOCALHOST callback listener and KEEPS it bound between two tool calls, so
// it only makes sense where the server runs on the user's own machine and serves exactly one user:
// the flow — its PKCE verifier and its `state` — is per process, not per session. The remote bridge
// authorizes through its own public callback and injects a ready TokenProvider; it passes no login
// deps and offers no login tool.
export function registerAuthTools(server, login) {
    if (!login)
        return;
    server.registerTool('zendesk_login', {
        description: 'Authorize this Zendesk extension. Call it TWICE: the first call returns a Zendesk authorization URL and starts listening for the redirect — show that URL to the user so they can open and approve it — then call this tool again to finish and store the credentials. It reports "already authorized" when usable credentials exist; use force=true to authorize again, or to restart an authorization already in progress.',
        inputSchema: { force: z.boolean().optional() },
    }, async ({ force }) => toText(await runLogin(login, { force })));
}
