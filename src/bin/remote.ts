import { buildRemoteApp } from '../remote/remote-server.js';
import { log } from '../remote/logger.js';

// Remote MCP entrypoint (node dist/bin/remote.js). Kept separate from the stdio server so the
// stdio path is entirely unaffected.
const port = Number(process.env.PORT || 8080);
buildRemoteApp().app.listen(port, () => log({ msg: `remote MCP listening on ${port}` }));
