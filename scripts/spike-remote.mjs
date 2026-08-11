// scripts/spike-remote.mjs — THROWAWAY verification spike for M9 Task 0.
//
// Purpose: a minimal remote MCP over Streamable HTTP the Owner can deploy to the EU VM behind TLS
// and register as a claude.ai custom connector. Its only job is to REVEAL the real connector
// contract (which discovery docs claude.ai fetches, whether it uses RFC 7591 dynamic client
// registration or a pre-shared client_id, the exact redirect URIs, PKCE method, and the Bearer
// header format). Record the observed values in src/remote/connector-contract.ts, then delete this
// file. No production code depends on it.
//
// Run:  REMOTE_PUBLIC_URL=https://<host> node scripts/spike-remote.mjs
import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Log EVERY request line + headers (NO bodies) so the live registration reveals the contract.
app.use((req, _res, next) => {
  console.error(`[spike] ${req.method} ${req.url} :: ${JSON.stringify(req.headers)}`);
  next();
});

app.post('/mcp', async (req, res) => {
  const server = new McpServer({ name: 'zendesk-spike', version: '0.0.0' });
  server.tool('ping', 'spike probe', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(Number(process.env.PORT ?? 8080), () => console.error('[spike] up'));
