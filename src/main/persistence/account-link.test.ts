import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type DatabaseSync } from 'node:sqlite';
import {
  AccountLinkError,
  commitAccountConnection,
  listGoogleAccounts,
  markRefreshTokenUnusable,
  noteGoogleReauth,
  readGoogleClient,
  readGoogleClientState,
  replaceAccountRefreshToken,
  saveGoogleClient,
  saveGoogleClientId
} from './account-link.ts';
import { getConnectedAccount } from './accounts.ts';
import { readAccountRefreshToken, readClientSecret } from './credentials.ts';
import { openAuroraDatabase } from './database.ts';
import { PersistenceError } from './errors.ts';
import { type SecretCipher } from './safe-storage-cipher.ts';

const directories: string[] = [];
const databases: DatabaseSync[] = [];

function openTemp(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), 'aurora-account-link-'));
  directories.push(directory);
  const database = openAuroraDatabase(join(directory, 'aurora.sqlite'));
  databases.push(database);
  return database;
}

after(() => {
  for (const database of databases) {
    try {
      database.exec('ROLLBACK');
    } catch {
      void database;
    }
    database.close();
  }
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function xorCipher(failDecrypt = false): SecretCipher {
  return {
    encrypt(plaintext: string): Buffer {
      const bytes = Buffer.from(plaintext, 'utf8');
      for (let index = 0; index < bytes.length; index += 1)
        bytes[index] = (bytes[index] ?? 0) ^ 0x5a;
      return bytes;
    },
    decrypt(ciphertext: Buffer): string {
      if (failDecrypt) throw new Error('decrypt');
      const bytes = Buffer.from(ciphertext);
      for (let index = 0; index < bytes.length; index += 1)
        bytes[index] = (bytes[index] ?? 0) ^ 0x5a;
      return bytes.toString('utf8');
    }
  };
}

function blob(database: DatabaseSync, accountId: string): Buffer {
  const row = database
    .prepare(
      "SELECT ciphertext FROM credential_secrets WHERE account_id = ? AND kind = 'refresh_token'"
    )
    .get(accountId);
  assert.ok(row);
  const value = row.ciphertext;
  assert.ok(ArrayBuffer.isView(value));
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

describe('Google account link', () => {
  it('rejects a new connected account without a refresh token', () => {
    const database = openTemp();
    const client = saveGoogleClientId(database, 'desktop-client.apps.googleusercontent.com');
    assert.throws(
      () =>
        commitAccountConnection(database, xorCipher(), {
          oauthClientId: client.id,
          providerAccountId: 'google-user-1',
          displayName: 'Ada',
          email: 'ada@example.com',
          refreshToken: null,
          expectedAccountId: null,
          grantedScopes: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
        }),
      (error: unknown) =>
        error instanceof AccountLinkError && error.code === 'missing-refresh-token'
    );
    assert.deepEqual(listGoogleAccounts(database), []);
  });

  it('keeps a usable token when reconnection does not receive a replacement', () => {
    const database = openTemp();
    const cipher = xorCipher();
    const client = saveGoogleClientId(database, 'desktop-client.apps.googleusercontent.com');
    const created = commitAccountConnection(database, cipher, {
      oauthClientId: client.id,
      providerAccountId: 'google-user-1',
      displayName: 'Ada',
      email: 'ada@example.com',
      refreshToken: 'refresh-token-one',
      expectedAccountId: null,
      grantedScopes: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
    });
    const original = blob(database, created.id);
    const updated = commitAccountConnection(database, cipher, {
      oauthClientId: client.id,
      providerAccountId: 'google-user-1',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      refreshToken: null,
      expectedAccountId: created.id,
      grantedScopes: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
    });
    assert.equal(updated.displayName, 'Ada Lovelace');
    assert.equal(updated.status, 'connected');
    assert.equal(blob(database, created.id).equals(original), true);
    assert.equal(readAccountRefreshToken(database, cipher, created.id), 'refresh-token-one');
  });

  it('does not destroy credentials when the replacement write aborts', () => {
    const database = openTemp();
    const cipher = xorCipher();
    const client = saveGoogleClientId(database, 'desktop-client.apps.googleusercontent.com');
    const created = commitAccountConnection(database, cipher, {
      oauthClientId: client.id,
      providerAccountId: 'google-user-1',
      displayName: 'Ada',
      email: 'ada@example.com',
      refreshToken: 'refresh-token-one',
      expectedAccountId: null,
      grantedScopes: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
    });
    const original = blob(database, created.id);
    database.exec(`
      CREATE TRIGGER abort_credential_update
      BEFORE UPDATE ON credential_secrets
      BEGIN
        SELECT RAISE(ABORT, 'fail');
      END;
    `);
    assert.throws(() =>
      commitAccountConnection(database, cipher, {
        oauthClientId: client.id,
        providerAccountId: 'google-user-1',
        displayName: 'Changed',
        email: 'new@example.com',
        refreshToken: 'refresh-token-two',
        expectedAccountId: created.id,
        grantedScopes: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
      })
    );
    const account = getConnectedAccount(database, created.id);
    assert.equal(account.displayName, 'Ada');
    assert.equal(account.email, 'ada@example.com');
    assert.equal(account.status, 'connected');
    assert.equal(blob(database, created.id).equals(original), true);
  });

  it('leaves an unusable stored token untouched when Google omits a replacement', () => {
    const database = openTemp();
    const client = saveGoogleClientId(database, 'desktop-client.apps.googleusercontent.com');
    const created = commitAccountConnection(database, xorCipher(), {
      oauthClientId: client.id,
      providerAccountId: 'google-user-1',
      displayName: 'Ada',
      email: null,
      refreshToken: 'refresh-token-one',
      expectedAccountId: null,
      grantedScopes: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
    });
    const original = blob(database, created.id);
    assert.throws(
      () =>
        commitAccountConnection(database, xorCipher(true), {
          oauthClientId: client.id,
          providerAccountId: 'google-user-1',
          displayName: 'Changed',
          email: 'ada@example.com',
          refreshToken: null,
          expectedAccountId: created.id,
          grantedScopes: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
        }),
      (error: unknown) => error instanceof AccountLinkError && error.code === 'needs-reauth'
    );
    const account = getConnectedAccount(database, created.id);
    assert.equal(account.displayName, 'Ada');
    assert.equal(account.status, 'connected');
    assert.equal(blob(database, created.id).equals(original), true);
  });

  it('replaces a rotated token, isolates accounts, and refuses the wrong subject', () => {
    const database = openTemp();
    const cipher = xorCipher();
    const client = saveGoogleClientId(database, 'desktop-client.apps.googleusercontent.com');
    const first = commitAccountConnection(database, cipher, {
      oauthClientId: client.id,
      providerAccountId: 'google-user-1',
      displayName: 'Ada',
      email: 'ada@example.com',
      refreshToken: 'refresh-token-one',
      expectedAccountId: null,
      grantedScopes: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
    });
    const second = commitAccountConnection(database, cipher, {
      oauthClientId: client.id,
      providerAccountId: 'google-user-2',
      displayName: 'Grace',
      email: null,
      refreshToken: 'refresh-token-two',
      expectedAccountId: null,
      grantedScopes: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
    });
    const rotated = commitAccountConnection(database, cipher, {
      oauthClientId: client.id,
      providerAccountId: 'google-user-1',
      displayName: 'Ada',
      email: 'ada@example.com',
      refreshToken: 'refresh-token-rotated',
      expectedAccountId: null,
      grantedScopes: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
    });
    assert.equal(rotated.id, first.id);
    assert.equal(readAccountRefreshToken(database, cipher, first.id), 'refresh-token-rotated');
    assert.equal(readAccountRefreshToken(database, cipher, second.id), 'refresh-token-two');
    assert.throws(
      () =>
        commitAccountConnection(database, cipher, {
          oauthClientId: client.id,
          providerAccountId: 'google-user-2',
          displayName: 'Grace',
          email: null,
          refreshToken: 'refresh-token-other',
          expectedAccountId: first.id,
          grantedScopes: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
        }),
      (error: unknown) => error instanceof AccountLinkError && error.code === 'account-mismatch'
    );
    assert.equal(readAccountRefreshToken(database, cipher, first.id), 'refresh-token-rotated');
    assert.equal(getConnectedAccount(database, first.id).providerAccountId, 'google-user-1');
  });

  it('retires a revoked token and keeps ciphertext when only the status changes', () => {
    const database = openTemp();
    const cipher = xorCipher();
    const client = saveGoogleClientId(database, 'desktop-client.apps.googleusercontent.com');
    const account = commitAccountConnection(database, cipher, {
      oauthClientId: client.id,
      providerAccountId: 'google-user-1',
      displayName: null,
      email: null,
      refreshToken: 'refresh-token-one',
      expectedAccountId: null,
      grantedScopes: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
    });
    const original = blob(database, account.id);
    noteGoogleReauth(database, account.id);
    assert.equal(getConnectedAccount(database, account.id).status, 'needs_reauth');
    assert.equal(blob(database, account.id).equals(original), true);
    replaceAccountRefreshToken(database, cipher, account.id, 'refresh-token-two');
    assert.equal(readAccountRefreshToken(database, cipher, account.id), 'refresh-token-two');
    markRefreshTokenUnusable(database, account.id);
    assert.equal(getConnectedAccount(database, account.id).status, 'needs_reauth');
    assert.equal(
      database.prepare('SELECT id FROM credential_secrets WHERE account_id = ?').get(account.id),
      undefined
    );
    assert.throws(() =>
      replaceAccountRefreshToken(database, cipher, account.id, 'refresh-token-three')
    );
  });

  it('refuses a different client id while a Google account exists', () => {
    const database = openTemp();
    const client = saveGoogleClientId(database, 'desktop-client.apps.googleusercontent.com');
    commitAccountConnection(database, xorCipher(), {
      oauthClientId: client.id,
      providerAccountId: 'google-user-1',
      displayName: null,
      email: null,
      refreshToken: 'refresh-token-one',
      expectedAccountId: null,
      grantedScopes: 'openid email profile https://www.googleapis.com/auth/gmail.modify'
    });
    assert.throws(
      () => saveGoogleClientId(database, 'other-client.apps.googleusercontent.com'),
      (error: unknown) => error instanceof AccountLinkError && error.code === 'client-in-use'
    );
    assert.equal(readGoogleClient(database)?.clientId, 'desktop-client.apps.googleusercontent.com');
    assert.throws(
      () => saveGoogleClientId(database, 'not-a-google-client'),
      (error: unknown) => error instanceof PersistenceError && error.code === 'invalid'
    );
  });

  it('updates the client id when no Google account exists and rejects a duplicate row', () => {
    const database = openTemp();
    assert.equal(readGoogleClient(database), null);
    const first = saveGoogleClientId(database, 'desktop-client.apps.googleusercontent.com');
    assert.equal(saveGoogleClientId(database, first.clientId).id, first.id);
    const updated = saveGoogleClientId(database, 'other-client.apps.googleusercontent.com');
    assert.equal(updated.clientId, 'other-client.apps.googleusercontent.com');
    database
      .prepare(
        `INSERT INTO oauth_clients (id, provider, client_id, created_at, updated_at)
         VALUES (?, 'google', ?, ?, ?)`
      )
      .run(
        '00000000-0000-4000-8000-000000000099',
        'third-client.apps.googleusercontent.com',
        new Date().toISOString(),
        new Date().toISOString()
      );
    assert.throws(
      () => readGoogleClient(database),
      (error: unknown) => error instanceof PersistenceError && error.code === 'internal'
    );
  });

  it('stores a client secret as ciphertext and does not return it', () => {
    const database = openTemp();
    const cipher = xorCipher();
    const saved = saveGoogleClient(
      database,
      cipher,
      'desktop-client.apps.googleusercontent.com',
      'client-secret-value'
    );
    assert.equal(saved.secretConfigured, true);
    assert.equal(JSON.stringify(saved).includes('client-secret-value'), false);
    assert.equal(
      readClientSecret(database, cipher, readGoogleClient(database)?.id ?? ''),
      'client-secret-value'
    );
    const row = database
      .prepare("SELECT ciphertext FROM credential_secrets WHERE kind = 'client_secret'")
      .get();
    assert.ok(row);
    const ciphertext = row.ciphertext;
    assert.ok(ArrayBuffer.isView(ciphertext));
    const bytes = Buffer.from(ciphertext.buffer, ciphertext.byteOffset, ciphertext.byteLength);
    assert.equal(bytes.includes(Buffer.from('client-secret-value')), false);
    const kept = saveGoogleClient(
      database,
      cipher,
      'desktop-client.apps.googleusercontent.com',
      null
    );
    assert.deepEqual(kept, saved);
    assert.deepEqual(readGoogleClientState(database), {
      clientId: 'desktop-client.apps.googleusercontent.com',
      secretConfigured: true
    });
    assert.throws(
      () =>
        saveGoogleClient(
          database,
          cipher,
          'desktop-client.apps.googleusercontent.com',
          'bad\nsecret'
        ),
      (error: unknown) => error instanceof PersistenceError && error.code === 'invalid'
    );
  });
});
