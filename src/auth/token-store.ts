import { EncryptedFile } from './encrypted-file.js';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

// The per-identity Zendesk credential file. Thin by design: the cipher lives in EncryptedFile, so
// this type carries exactly the three slots a Zendesk grant has and nothing a downstream concern
// wanted to borrow.
export class TokenStore {
  private readonly file: EncryptedFile;

  constructor(filePath: string, encryptionSecret: string) {
    this.file = new EncryptedFile(filePath, encryptionSecret);
  }

  save(tokens: StoredTokens): void {
    this.file.save(tokens);
  }

  load(): StoredTokens | null {
    return this.file.load<StoredTokens>();
  }

  clear(): void {
    this.file.clear();
  }
}
