// src/tools/uploads.ts
import type { ZendeskHttpClient } from '../client/http-client.js';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // Zendesk hard limit is plan-dependent; cap defensively.

// This tool is outbound-only (uploading a file the caller supplied). No inbound
// attachment content is fetched here.
// TODO(later): screen downloaded attachment content when an inbound-download tool exists.
export async function uploadAttachment(
  client: ZendeskHttpClient,
  params: { filename: string; contentBase64: string; contentType?: string },
): Promise<{ token: string }> {
  if (params.filename.trim() === '') throw new Error('An attachment filename is required.');
  const bytes = Buffer.from(params.contentBase64, 'base64');
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(`Attachment exceeds the ${MAX_UPLOAD_BYTES}-byte upload cap.`);
  }
  const path = `/uploads.json?filename=${encodeURIComponent(params.filename)}`;
  const raw = await client.requestUpload<{ upload: { token: string } }>(path, bytes, params.contentType ?? 'application/binary');
  return { token: raw.upload.token };
}
