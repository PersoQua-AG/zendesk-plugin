import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../server.js';
// No main-module check: it is false when ${CLAUDE_PLUGIN_ROOT} is reached through a symlink (#45).
const { server } = createServer();
await server.connect(new StdioServerTransport());
