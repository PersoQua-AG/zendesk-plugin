// tests/tools/uploads.test.ts
import { describe, it, expect, vi } from 'vitest';
import { uploadAttachment, MAX_UPLOAD_BASE64_CHARS } from '../../src/tools/uploads.js';
import type { ZendeskHttpClient } from '../../src/client/http-client.js';

describe('uploadAttachment', () => {
  it('decodes base64 and uploads with the filename in the query string', async () => {
    const client = { requestUpload: vi.fn().mockResolvedValue({ upload: { token: 'up-42' } }) } as unknown as ZendeskHttpClient;
    const contentBase64 = Buffer.from('hello').toString('base64');
    const result = await uploadAttachment(client, { filename: 'note.txt', contentBase64, contentType: 'text/plain' });

    const [path, body, contentType] = (client.requestUpload as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe('/uploads.json?filename=note.txt');
    expect(Buffer.from(body).toString('utf8')).toBe('hello');
    expect(contentType).toBe('text/plain');
    expect(result.token).toBe('up-42');
  });

  it('rejects an empty filename', async () => {
    const client = { requestUpload: vi.fn() } as unknown as ZendeskHttpClient;
    await expect(uploadAttachment(client, { filename: '', contentBase64: 'AA==' })).rejects.toThrow(/filename/i);
  });

  it('rejects content exceeding the max upload size', async () => {
    const client = { requestUpload: vi.fn() } as unknown as ZendeskHttpClient;
    const big = Buffer.alloc(51 * 1024 * 1024).toString('base64');
    await expect(uploadAttachment(client, { filename: 'big.bin', contentBase64: big })).rejects.toThrow(/exceeds/i);
    expect(client.requestUpload).not.toHaveBeenCalled();
  });

  it('rejects an oversized base64 string by estimate, before decoding it', async () => {
    const client = { requestUpload: vi.fn() } as unknown as ZendeskHttpClient;
    // A raw base64 char count above the cap — no valid payload is decoded/allocated.
    const spy = vi.spyOn(Buffer, 'from');
    const oversized = 'A'.repeat(MAX_UPLOAD_BASE64_CHARS + 8);
    await expect(uploadAttachment(client, { filename: 'huge.bin', contentBase64: oversized })).rejects.toThrow(/exceeds/i);
    expect(client.requestUpload).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('accepts exactly MAX_UPLOAD_BASE64_CHARS but rejects one char more (schema/decode agree)', async () => {
    const client = { requestUpload: vi.fn().mockResolvedValue({ upload: { token: 'up-edge' } }) } as unknown as ZendeskHttpClient;
    // The schema .max() ceiling must be the exact boundary the decode-size check enforces:
    // the ceiling itself decodes within the cap, one char beyond it does not.
    const atCap = 'A'.repeat(MAX_UPLOAD_BASE64_CHARS);
    await expect(uploadAttachment(client, { filename: 'edge.bin', contentBase64: atCap })).resolves.toEqual({ token: 'up-edge' });

    const overCap = 'A'.repeat(MAX_UPLOAD_BASE64_CHARS + 1);
    await expect(uploadAttachment(client, { filename: 'edge.bin', contentBase64: overCap })).rejects.toThrow(/exceeds/i);
  });
});
