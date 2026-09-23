import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// One AES-256-GCM record per file: iv | authTag | ciphertext, base64, mode 0600. This is the single
// cipher implementation in the codebase — TokenStore (Zendesk credentials) and OpaqueTokenStore
// (the tokens we issue to claude.ai) both sit on it, so each role can carry the record shape it
// needs without a second crypto path to review, and without widening a shared type to fit a
// downstream concern. The on-disk format is unchanged from the original TokenStore, so files
// written by earlier versions still decrypt.
export class EncryptedFile {
  private readonly key: Buffer;

  constructor(
    private readonly filePath: string,
    encryptionSecret: string,
  ) {
    this.key = createHash('sha256').update(encryptionSecret).digest();
  }

  save(record: unknown): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(record), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    writeFileSync(this.filePath, payload, { mode: 0o600 });
  }

  // null for a missing or empty file. A decrypt/integrity failure THROWS: a tampered or
  // wrong-key file must never be mistaken for "not there".
  load<T>(): T | null {
    if (!existsSync(this.filePath)) return null;
    const raw = readFileSync(this.filePath, 'utf8');
    if (raw.length === 0) return null;
    const payload = Buffer.from(raw, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    const decrypted = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8')) as T;
  }

  clear(): void {
    if (existsSync(this.filePath)) writeFileSync(this.filePath, '');
  }
}
