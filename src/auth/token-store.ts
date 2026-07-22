import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class TokenStore {
  private readonly filePath: string;
  private readonly key: Buffer;

  constructor(filePath: string, encryptionSecret: string) {
    this.filePath = filePath;
    this.key = createHash('sha256').update(encryptionSecret).digest();
  }

  save(tokens: StoredTokens): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(tokens), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, authTag, encrypted]).toString('base64');
    writeFileSync(this.filePath, payload, { mode: 0o600 });
  }

  load(): StoredTokens | null {
    if (!existsSync(this.filePath)) return null;
    const raw = readFileSync(this.filePath, 'utf8');
    if (raw.length === 0) return null;
    const payload = Buffer.from(raw, 'base64');
    const iv = payload.subarray(0, 12);
    const authTag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8')) as StoredTokens;
  }

  clear(): void {
    if (existsSync(this.filePath)) writeFileSync(this.filePath, '');
  }
}
