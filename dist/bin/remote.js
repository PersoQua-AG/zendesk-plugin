import { fileURLToPath } from 'node:url';
import { buildRemoteApp } from '../remote/remote-server.js';
import { log } from '../remote/logger.js';
// Remote MCP entrypoint (node dist/bin/remote.js). Kept separate from the stdio server so the
// stdio path is entirely unaffected. Guarded so importing this module (e.g. in tests) does not
// bind a port — only a direct `node remote.js` invocation listens.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const port = Number(process.env.PORT || 8080);
    buildRemoteApp().app.listen(port, () => log({ msg: `remote MCP listening on ${port}` }));
}
