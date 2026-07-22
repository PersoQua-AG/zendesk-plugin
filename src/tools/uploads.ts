// src/tools/uploads.ts
import type { ZendeskHttpClient } from '../client/http-client.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // Zendesk hard limit is plan-dependent; cap defensively.
// Base64 encodes 3 bytes per 4 chars, so this many chars is the largest input whose
// decoded size can stay within MAX_UPLOAD_BYTES. Used as the schema .max() ceiling.
export const MAX_UPLOAD_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;

// Upper bound on the decoded byte size of a base64 string, without allocating it.
// floor(len * 3/4) >= actual decoded bytes, so a pass here guarantees the decode is safe.
function estimatedDecodedBytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

// This tool is outbound-only (uploading a file the caller supplied). No inbound
// attachment content is fetched here.
// TODO(later): screen downloaded attachment content when an inbound-download tool exists.
export async function uploadAttachment(
  client: ZendeskHttpClient,
  params: { filename: string; contentBase64: string; contentType?: string },
): Promise<{ token: string }> {
  if (params.filename.trim() === '') throw new Error('An attachment filename is required.');
  // Reject oversized input BEFORE decoding, so an attacker cannot force a huge Buffer
  // allocation just to have it thrown away afterwards.
  if (estimatedDecodedBytes(params.contentBase64) > MAX_UPLOAD_BYTES) {
    throw new Error(`Attachment exceeds the ${MAX_UPLOAD_BYTES}-byte upload cap.`);
  }
  const bytes = Buffer.from(params.contentBase64, 'base64');
  const path = `/uploads.json?filename=${encodeURIComponent(params.filename)}`;
  const raw = await client.requestUpload<{ upload: { token: string } }>(path, bytes, params.contentType ?? 'application/octet-stream');
  return { token: raw.upload.token };
}
