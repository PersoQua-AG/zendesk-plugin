// tests/tools/uploads.test.ts
import { describe, it, expect, vi } from 'vitest';
import { uploadAttachment } from '../../src/tools/uploads.js';
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
});
