export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // Zendesk hard limit is plan-dependent; cap defensively.
// The largest base64 length whose estimated decode (floor(len*3/4)) is still within
// MAX_UPLOAD_BYTES — i.e. the exact boundary the decode-size check enforces, so the schema
// .max() ceiling and the runtime check agree. Derived from floor(len*3/4) <= MAX ⟺
// len <= floor((4*MAX + 3)/3); Math.ceil(MAX/3)*4 overshot by one char.
export const MAX_UPLOAD_BASE64_CHARS = Math.floor((MAX_UPLOAD_BYTES * 4 + 3) / 3);
// Upper bound on the decoded byte size of a base64 string, without allocating it.
// floor(len * 3/4) >= actual decoded bytes, so a pass here guarantees the decode is safe.
function estimatedDecodedBytes(base64) {
    return Math.floor((base64.length * 3) / 4);
}
// This tool is outbound-only (uploading a file the caller supplied). No inbound
// attachment content is fetched here.
// TODO(later): screen downloaded attachment content when an inbound-download tool exists.
export async function uploadAttachment(client, params) {
    if (params.filename.trim() === '')
        throw new Error('An attachment filename is required.');
    // Reject oversized input BEFORE decoding, so an attacker cannot force a huge Buffer
    // allocation just to have it thrown away afterwards.
    if (estimatedDecodedBytes(params.contentBase64) > MAX_UPLOAD_BYTES) {
        throw new Error(`Attachment exceeds the ${MAX_UPLOAD_BYTES}-byte upload cap.`);
    }
    const bytes = Buffer.from(params.contentBase64, 'base64');
    const path = `/uploads.json?filename=${encodeURIComponent(params.filename)}`;
    const raw = await client.requestUpload(path, bytes, params.contentType ?? 'application/octet-stream');
    return { token: raw.upload.token };
}
