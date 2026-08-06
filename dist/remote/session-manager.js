import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../server.js';
import { ResponseCache } from '../client/cache.js';
import { log } from './logger.js';
// Mutating tools worth an audit trail (REQ-10). Reads are intentionally not audited.
const WRITE_TOOL = /^zendesk_(update|create|apply|add|upsert|import|bulk|attach|delete|remove|set)/;
const TARGET_KEYS = [
    'id', 'ticketId', 'ticket_id', 'userId', 'user_id', 'organizationId', 'organization_id', 'articleId', 'article_id',
];
// Per-user cache dir = isolation by construction: cache.ts confines every handle to its own dir,
// so one identity's handles are unreachable from another's cache.
export function sessionCacheDir(dataDir, identity) {
    const hash = createHash('sha256').update(`zendesk-user:${identity}`).digest('hex');
    return join(dataDir, 'cache', hash);
}
function targetIdOf(args) {
    if (args && typeof args === 'object') {
        const rec = args;
        for (const key of TARGET_KEYS) {
            const v = rec[key];
            if (typeof v === 'string' || typeof v === 'number')
                return String(v);
        }
    }
    return 'n/a';
}
function idOf(msg) {
    const id = msg.id;
    return id === null || id === undefined ? undefined : id;
}
function writeCallOf(msg) {
    const id = idOf(msg);
    if (id === undefined || !('method' in msg) || msg.method !== 'tools/call')
        return null;
    const params = msg.params;
    const name = params?.name;
    if (typeof name !== 'string' || !WRITE_TOOL.test(name))
        return null;
    return { id, tool: name, targetId: targetIdOf(params?.arguments) };
}
function outcomeOf(msg) {
    const id = idOf(msg);
    if (id === undefined)
        return null;
    if ('error' in msg)
        return { id, outcome: 'error' };
    if (!('result' in msg))
        return null;
    const result = msg.result;
    if (result?.isError)
        return { id, outcome: 'error' };
    const text = (result?.content ?? []).map((c) => c.text ?? '').join(' ');
    return { id, outcome: /conflict/i.test(text) ? 'conflict' : 'applied' };
}
// Correlates inbound tools/call with its outbound result by JSON-RPC id and records one audit
// entry per write. Exported so the correlation is unit-testable without a live transport.
export function createAuditObserver(audit, identity) {
    const pending = new Map();
    return {
        onInbound(msg) {
            const call = writeCallOf(msg);
            if (call)
                pending.set(call.id, { tool: call.tool, targetId: call.targetId });
        },
        onOutbound(msg) {
            const done = outcomeOf(msg);
            if (!done)
                return;
            const meta = pending.get(done.id);
            if (!meta)
                return;
            pending.delete(done.id);
            audit.record(identity, meta.tool, meta.targetId, done.outcome);
        },
    };
}
// Maps Mcp-Session-Id → per-user transport. Each session builds its OWN createServer over the
// authenticated identity's TokenProvider + a per-user cache dir; rate limiters are shared
// (account-wide budget). The 64 tools never learn any of this.
export class SessionManager {
    env;
    deps;
    sessions = new Map();
    constructor(env, deps) {
        this.env = env;
        this.deps = deps;
    }
    async handlePost(req, res) {
        const sid = sessionId(req);
        const bound = sid ? this.sessions.get(sid) : undefined;
        if (bound)
            return this.routeTo(bound, req, res);
        if (!sid && isInitializeRequest(req.body))
            return this.openSession(req, res);
        reject(res, 400, 'No valid session; initialize first.');
    }
    async handleGet(req, res) {
        return this.routeExisting(req, res);
    }
    async handleDelete(req, res) {
        return this.routeExisting(req, res);
    }
    async routeExisting(req, res) {
        const sid = sessionId(req);
        const bound = sid ? this.sessions.get(sid) : undefined;
        if (!bound)
            return reject(res, 404, 'Unknown session.');
        return this.routeTo(bound, req, res);
    }
    // Fail-closed session-identity binding: a session may only be driven by the SAME authenticated
    // identity that opened it. Routing on the session id alone would let user B's valid bearer drive
    // user A's session — and thus A's Zendesk token. Verify before touching the session's transport.
    routeTo(bound, req, res) {
        if (identityOf(req) !== bound.identity) {
            return reject(res, 403, 'Session belongs to a different identity.');
        }
        return bound.transport.handleRequest(req, res, req.body);
    }
    async openSession(req, res) {
        const identity = identityOf(req);
        const cache = new ResponseCache(sessionCacheDir(this.deps.dataDir, identity));
        const { server } = createServer(this.env, {
            authManager: this.deps.resolver.forIdentity(identity),
            rateLimiter: this.deps.rateLimiter,
            incrementalRateLimiter: this.deps.incrementalRateLimiter,
            cache,
            fetchImpl: this.deps.fetchImpl,
        });
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            // DNS-rebinding protection, gated on a configured public URL so local/test hosts still work (L1).
            ...this.dnsRebindingGuard(),
            onsessioninitialized: (id) => {
                this.sessions.set(id, { transport, identity });
            },
        });
        transport.onclose = () => {
            if (transport.sessionId)
                this.sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        this.wireAudit(transport, identity);
        await transport.handleRequest(req, res, req.body);
    }
    // Only enforce Host/Origin checks when REMOTE_PUBLIC_URL is set (production); local/test clients
    // reach the app by 127.0.0.1/localhost and must not be locked out (L1).
    dnsRebindingGuard() {
        const publicUrl = this.env.REMOTE_PUBLIC_URL;
        if (!publicUrl)
            return {};
        return { enableDnsRebindingProtection: true, allowedHosts: [new URL(publicUrl).host] };
    }
    // Wrap the transport's message hooks AFTER connect (server already installed them) so we observe
    // both directions without replacing tool dispatch — no tool-file edit.
    wireAudit(transport, identity) {
        const obs = createAuditObserver(this.deps.audit, identity);
        const innerOnMessage = transport.onmessage?.bind(transport);
        transport.onmessage = (msg, extra) => {
            obs.onInbound(msg);
            innerOnMessage?.(msg, extra);
        };
        const innerSend = transport.send.bind(transport);
        transport.send = async (msg, opts) => {
            obs.onOutbound(msg);
            return innerSend(msg, opts);
        };
    }
}
function sessionId(req) {
    const value = req.headers['mcp-session-id'];
    return Array.isArray(value) ? value[0] : value;
}
function identityOf(req) {
    const identity = req.auth?.extra?.identity;
    if (typeof identity !== 'string' || identity.length === 0) {
        // Fail-closed → 401 (same re-auth signal as an unknown/expired token) via the SDK-mapped type.
        throw new InvalidTokenError('Authenticated session is missing a Zendesk identity.');
    }
    return identity;
}
function reject(res, status, message) {
    log({ msg: `session rejected: ${message}`, outcome: String(status) });
    if (res.headersSent)
        return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
}
