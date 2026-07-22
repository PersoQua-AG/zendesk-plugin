// src/tools/result.ts
// Shared read-tool result shape + MCP content-envelope render helpers.
// Contract: read/list tools return a ReadResult (screened summary + cache handle).
// Scalar or mutating tools (e.g. uploadAttachment, searchCount) legitimately have
// no cacheHandle and therefore do not use ReadResult / okWithHandle.
export interface ReadResult {
  summary: string;
  cacheHandle: string;
  flagged: boolean;
}

// The single MCP text content-envelope, deduped from the per-handler copies.
export function toText(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

// Standard render for a tool result that carries a cache handle.
export function okWithHandle(r: { summary: string; cacheHandle: string }) {
  return toText(`${r.summary}\n(cache: ${r.cacheHandle})`);
}
