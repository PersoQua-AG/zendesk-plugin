import { EncryptedFile } from './encrypted-file.js';
// The per-identity Zendesk credential file. Thin by design: the cipher lives in EncryptedFile, so
// this type carries exactly the three slots a Zendesk grant has and nothing a downstream concern
// wanted to borrow.
export class TokenStore {
    file;
    constructor(filePath, encryptionSecret) {
        this.file = new EncryptedFile(filePath, encryptionSecret);
    }
    save(tokens) {
        this.file.save(tokens);
    }
    load() {
        return this.file.load();
    }
    clear() {
        this.file.clear();
    }
}
