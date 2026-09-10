import { z } from 'zod';
import { toText } from '../tools/result.js';
import { runLogin } from '../tools/login.js';
// Login deps are a second parameter, not a ToolContext field: LoginDeps carries the OAuth client
// secret, and none of the other 64 registrars has any business reaching it through the shared ctx.
// Passing it here also makes the local-vs-remote mode switch visible at the call site in server.ts.
//
// The login flow binds a LOCALHOST callback listener, so it only makes sense where the server runs
// on the user's own machine. The remote bridge authorizes through its own public callback and
// injects a ready TokenProvider — it passes no login deps and offers no login tool.
export function registerAuthTools(server, login) {
    if (!login)
        return;
    server.registerTool('zendesk_login', {
        description: 'Authorize this Zendesk extension. Returns the Zendesk authorization URL to open in a browser and waits for the redirect, then stores the credentials. Use force=true to authorize again when credentials already exist.',
        inputSchema: { force: z.boolean().optional() },
    }, async ({ force }) => toText(await runLogin(login, { force })));
}
