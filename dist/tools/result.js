// The single MCP text content-envelope, deduped from the per-handler copies.
export function toText(body) {
    return { content: [{ type: 'text', text: body }] };
}
// Standard render for a tool result that carries a cache handle.
export function okWithHandle(r) {
    return toText(`${r.summary}\n(cache: ${r.cacheHandle})`);
}
