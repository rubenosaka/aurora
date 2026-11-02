import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  createConnectedAccount,
  createOAuthClient,
  deleteConnectedAccount,
  deleteOAuthClient
} from './accounts.ts';
import {
  readAccountRefreshToken,
  readClientSecret,
  saveAccountRefreshToken,
  saveClientSecret
} from './credentials.ts';
import { openAuroraDatabase } from './database.ts';
import { PersistenceError } from './errors.ts';
import { type SecretCipher } from './safe-storage-cipher.ts';

const directories: string[] = [];

function openTemp() {
  const directory = mkdtempSync(join(tmpdir(), 'aurora-credentials-'));
  directories.push(directory);
  return openAuroraDatabase(join(directory, 'aurora.sqlite'));
}

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function xorCipher(): SecretCipher {
  return {
    encrypt(plaintext: string): Buffer {
      const bytes = Buffer.from(plaintext, 'utf8');
      for (let index = 0; index < bytes.length; index += 1) {
        const current = bytes[index] ?? 0;
        bytes[index] = current ^ 0x5a;
      }
      return bytes;
    },
    decrypt(ciphertext: Buffer): string {
      const bytes = Buffer.from(ciphertext);
      for (let index = 0; index < bytes.length; index += 1) {
        const current = bytes[index] ?? 0;
        bytes[index] = current ^ 0x5a;
      }
      return bytes.toString('utf8');
    }
  };
}

function codeOf(error: unknown): string {
  assert.ok(error instanceof PersistenceError);
  return error.code;
}

describe('credentials', () => {
  it('round-trips tokens for one owner and kind and keeps accounts isolated', () => {
    const database = openTemp();
    const cipher = xorCipher();
    const client = createOAuthClient(database, { provider: 'google', clientId: 'client-one' });
    const first = createConnectedAccount(database, {
      provider: 'google',
      providerAccountId: 'google-user-1',
      displayName: 'Ada',
      email: 'ada@example.com',
      status: 'connected',
      oauthClientId: client.id
    });
    const second = createConnectedAccount(database, {
      provider: 'google',
      providerAccountId: 'google-user-2',
      displayName: null,
      email: null,
      status: 'connected',
      oauthClientId: client.id
    });
    saveClientSecret(database, cipher, client.id, 'client-secret-value');
    saveAccountRefreshToken(database, cipher, first.id, 'refresh-token-one');
    saveAccountRefreshToken(database, cipher, first.id, 'refresh-token-one-rotated');
    saveAccountRefreshToken(database, cipher, second.id, 'refresh-token-two');
    assert.equal(readClientSecret(database, cipher, client.id), 'client-secret-value');
    assert.equal(readAccountRefreshToken(database, cipher, first.id), 'refresh-token-one-rotated');
    assert.equal(readAccountRefreshToken(database, cipher, second.id), 'refresh-token-two');

    const stored = database
      .prepare('SELECT ciphertext FROM credential_secrets WHERE account_id = ?')
      .get(first.id);
    assert.ok(stored?.ciphertext instanceof Uint8Array);
    assert.equal(
      Buffer.from(stored.ciphertext).equals(Buffer.from('refresh-token-one-rotated')),
      false
    );
    assert.throws(
      () => saveAccountRefreshToken(database, cipher, first.id, ''),
      (error) => codeOf(error) === 'invalid'
    );

    deleteConnectedAccount(database, first.id);
    assert.throws(
      () => readAccountRefreshToken(database, cipher, first.id),
      (error) => codeOf(error) === 'not-found'
    );
    assert.equal(readAccountRefreshToken(database, cipher, second.id), 'refresh-token-two');
    assert.equal(readClientSecret(database, cipher, client.id), 'client-secret-value');
    const remaining = database.prepare('SELECT COUNT(*) AS count FROM credential_secrets').get();
    assert.equal(remaining?.count, 2);
    database.close();
  });

  it('removes a client secret when its oauth client is deleted and accounts are gone', () => {
    const database = openTemp();
    const cipher = xorCipher();
    const client = createOAuthClient(database, { provider: 'google', clientId: 'client-one' });
    saveClientSecret(database, cipher, client.id, 'client-secret-value');
    deleteOAuthClient(database, client.id);
    assert.throws(
      () => readClientSecret(database, cipher, client.id),
      (error) => codeOf(error) === 'not-found'
    );
    const remaining = database.prepare('SELECT COUNT(*) AS count FROM credential_secrets').get();
    assert.equal(remaining?.count, 0);
    database.close();
  });

  it('writes nothing when encryption is unavailable', () => {
    const database = openTemp();
    const client = createOAuthClient(database, { provider: 'google', clientId: 'client-one' });
    const account = createConnectedAccount(database, {
      provider: 'google',
      providerAccountId: 'google-user-1',
      displayName: null,
      email: null,
      status: 'pending',
      oauthClientId: client.id
    });
    const cipher: SecretCipher = {
      encrypt(): Buffer {
        throw new PersistenceError('encryption-unavailable');
      },
      decrypt(): string {
        throw new Error('unused');
      }
    };
    assert.throws(
      () => saveAccountRefreshToken(database, cipher, account.id, 'refresh-token-one'),
      (error) => codeOf(error) === 'encryption-unavailable'
    );
    const remaining = database.prepare('SELECT COUNT(*) AS count FROM credential_secrets').get();
    assert.equal(remaining?.count, 0);
    database.close();
  });

  it('hides decryption failures and leaves the ciphertext in place', () => {
    const database = openTemp();
    const client = createOAuthClient(database, { provider: 'google', clientId: 'client-one' });
    const account = createConnectedAccount(database, {
      provider: 'google',
      providerAccountId: 'google-user-1',
      displayName: null,
      email: null,
      status: 'connected',
      oauthClientId: client.id
    });
    saveAccountRefreshToken(database, xorCipher(), account.id, 'refresh-token-one');
    const cipher: SecretCipher = {
      encrypt(): Buffer {
        return Buffer.from('unused');
      },
      decrypt(): string {
        throw new Error('refresh-token-one should not leak');
      }
    };
    assert.throws(
      () => readAccountRefreshToken(database, cipher, account.id),
      (error) => {
        assert.equal(codeOf(error), 'decrypt-failed');
        assert.equal(String(error).includes('refresh-token-one'), false);
        return true;
      }
    );
    const remaining = database.prepare('SELECT COUNT(*) AS count FROM credential_secrets').get();
    assert.equal(remaining?.count, 1);
    database.close();
  });

  it('rejects a credential row with two owners or the wrong kind', () => {
    const database = openTemp();
    const client = createOAuthClient(database, { provider: 'google', clientId: 'client-one' });
    const account = createConnectedAccount(database, {
      provider: 'google',
      providerAccountId: 'google-user-1',
      displayName: null,
      email: null,
      status: 'connected',
      oauthClientId: client.id
    });
    const insert = database.prepare(
      `INSERT INTO credential_secrets (
         id, account_id, oauth_client_id, kind, ciphertext, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const stamp = '2026-10-17T00:00:00.000Z';
    assert.throws(() =>
      insert.run(
        '00000000-0000-4000-8000-000000000001',
        account.id,
        client.id,
        'refresh_token',
        Buffer.from([1]),
        stamp,
        stamp
      )
    );
    assert.throws(() =>
      insert.run(
        '00000000-0000-4000-8000-000000000002',
        account.id,
        null,
        'client_secret',
        Buffer.from([1]),
        stamp,
        stamp
      )
    );
    const remaining = database.prepare('SELECT COUNT(*) AS count FROM credential_secrets').get();
    assert.equal(remaining?.count, 0);
    database.close();
  });
});
