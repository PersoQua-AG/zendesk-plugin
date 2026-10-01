// src/register/auth.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toText } from '../tools/result.js';
import { runLogin, type LoginDeps } from '../tools/login.js';

// Login deps are a second parameter, not a ToolContext field: LoginDeps carries the OAuth client
// secret, and none of the other 64 registrars has any business reaching it through the shared ctx.
// Passing it here also makes the local-vs-remote mode switch visible at the call site in server.ts.
//
// The flow binds a LOCALHOST listener and is per process, not per session, so it only fits a server
// on the user's own machine. The remote bridge authorizes through its own public callback and
// injects a ready TokenProvider: it passes no login deps and offers no login tool.
export function registerAuthTools(server: McpServer, login?: LoginDeps): void {
  if (!login) return;

  server.registerTool(
    'zendesk_login',
    {
      description:
        'Authorize this Zendesk extension. It takes two calls, one after the other — never both in the same turn. Call 1 returns a URL: show it to the user and wait. On a machine that is not set up yet that is a LOCAL setup page which collects the Zendesk subdomain, OAuth client id and client secret (never ask for those in the chat — the page exists so the secret does not pass through here) and then continues into the Zendesk login by itself. Otherwise it is the Zendesk authorization URL. Call 2 finishes and stores the credentials. Reports "already authorized" when usable credentials exist; force=true authorizes again, or restarts an authorization already in progress; setup=true re-opens the setup page when the stored subdomain, client id or secret is wrong.',
      inputSchema: { force: z.boolean().optional(), setup: z.boolean().optional() },
    },
    async ({ force, setup }) => toText(await runLogin(login, { force, setup })),
  );
}
