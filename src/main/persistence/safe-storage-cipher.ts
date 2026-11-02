import { PersistenceError } from './errors.ts';

export interface SecretCipher {
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

export interface SafeStorageBinding {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export function createSafeStorageCipher(storage: SafeStorageBinding): SecretCipher {
  return {
    encrypt(plaintext: string): Buffer {
      if (!storage.isEncryptionAvailable()) {
        throw new PersistenceError('encryption-unavailable');
      }
      try {
        return Buffer.from(storage.encryptString(plaintext));
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw new PersistenceError('encryption-unavailable');
      }
    },
    decrypt(ciphertext: Buffer): string {
      if (!storage.isEncryptionAvailable()) {
        throw new PersistenceError('encryption-unavailable');
      }
      try {
        return storage.decryptString(ciphertext);
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw new PersistenceError('decrypt-failed');
      }
    }
  };
}
