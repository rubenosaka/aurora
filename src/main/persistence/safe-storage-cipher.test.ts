import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PersistenceError } from './errors.ts';
import { createSafeStorageCipher, type SafeStorageBinding } from './safe-storage-cipher.ts';

function binding(overrides: Partial<SafeStorageBinding> = {}): SafeStorageBinding & {
  plainTextCalls: number;
} {
  return {
    plainTextCalls: 0,
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`sealed:${plainText}`),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8').replace(/^sealed:/, ''),
    ...overrides
  };
}

describe('createSafeStorageCipher', () => {
  it('round-trips through the injected storage binding', () => {
    const storage = binding();
    const cipher = createSafeStorageCipher(storage);
    const encrypted = cipher.encrypt('refresh-token-one');
    assert.equal(cipher.decrypt(encrypted), 'refresh-token-one');
    assert.equal(storage.plainTextCalls, 0);
  });

  it('does not encrypt when protection is unavailable', () => {
    let calls = 0;
    const cipher = createSafeStorageCipher(
      binding({
        isEncryptionAvailable: () => false,
        encryptString: () => {
          calls += 1;
          return Buffer.from('nope');
        }
      })
    );
    assert.throws(
      () => cipher.encrypt('refresh-token-one'),
      (error) => error instanceof PersistenceError && error.code === 'encryption-unavailable'
    );
    assert.equal(calls, 0);
  });

  it('hides encrypt and decrypt exception text', () => {
    const cipher = createSafeStorageCipher(
      binding({
        encryptString: () => {
          throw new Error('refresh-token-one in encrypt');
        },
        decryptString: () => {
          throw new Error('refresh-token-one in decrypt');
        }
      })
    );
    assert.throws(
      () => cipher.encrypt('refresh-token-one'),
      (error) => {
        assert.ok(error instanceof PersistenceError);
        assert.equal(error.code, 'encryption-unavailable');
        assert.equal(String(error).includes('refresh-token-one'), false);
        return true;
      }
    );
    assert.throws(
      () => cipher.decrypt(Buffer.from('sealed:refresh-token-one')),
      (error) => {
        assert.ok(error instanceof PersistenceError);
        assert.equal(error.code, 'decrypt-failed');
        assert.equal(String(error).includes('refresh-token-one'), false);
        return true;
      }
    );
  });
});
