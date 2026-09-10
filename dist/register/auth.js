import { z } from 'zod';
import { toText } from '../tools/result.js';
import { runLogin } from '../tools/login.js';
export function registerAuthTools(server, ctx) {
    const login = ctx.login;
    // The login flow binds a LOCALHOST callback listener, so it only makes sense where the server
    // runs on the user's own machine. The remote bridge authorizes through its own public callback
    // and injects a ready TokenProvider — it sets no login context and offers no login tool.
    if (!login)
        return;
    server.registerTool('zendesk_login', {
        description: 'Authorize this Zendesk extension. Returns the Zendesk authorization URL to open in a browser and waits for the redirect, then stores the credentials. Use force=true to authorize again when credentials already exist.',
        inputSchema: { force: z.boolean().optional() },
    }, async ({ force }) => toText(await runLogin(login, force ?? false)));
}
