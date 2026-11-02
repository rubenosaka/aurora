import { randomUUID } from 'node:crypto';
import { type DatabaseSync } from 'node:sqlite';
import { PersistenceError } from './errors.ts';
import { type SecretCipher } from './safe-storage-cipher.ts';
import { withTransaction } from './database.ts';

const accountCredentialKind = 'refresh_token';
const clientCredentialKind = 'client_secret';

function requireSecret(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192) {
    throw new PersistenceError('invalid');
  }
  return value;
}

function requireUuid(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new PersistenceError('invalid');
  }
  return value;
}

function encryptSecret(cipher: SecretCipher, plaintext: string): Buffer {
  try {
    return Buffer.from(cipher.encrypt(plaintext));
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError('encryption-unavailable');
  }
}

function decryptSecret(cipher: SecretCipher, ciphertext: Buffer): string {
  try {
    const plaintext = cipher.decrypt(ciphertext);
    if (typeof plaintext !== 'string' || plaintext.length < 1) {
      throw new PersistenceError('decrypt-failed');
    }
    return plaintext;
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError('decrypt-failed');
  }
}

function readCiphertext(value: unknown): Buffer {
  if (!ArrayBuffer.isView(value)) throw new PersistenceError('internal');
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function saveOwnedCredential(
  database: DatabaseSync,
  cipher: SecretCipher,
  ownerColumn: 'account_id' | 'oauth_client_id',
  ownerId: string,
  kind: typeof accountCredentialKind | typeof clientCredentialKind,
  plaintext: string,
  now: () => Date
): void {
  const secret = requireSecret(plaintext);
  const ciphertext = encryptSecret(cipher, secret);
  if (ciphertext.length < 1) throw new PersistenceError('internal');
  const timestamp = now().toISOString();
  withTransaction(database, () => {
    const existing = database
      .prepare(`SELECT id FROM credential_secrets WHERE ${ownerColumn} = ? AND kind = ?`)
      .get(ownerId, kind);
    if (existing === undefined) {
      database
        .prepare(
          `INSERT INTO credential_secrets (
             id, account_id, oauth_client_id, kind, ciphertext, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          ownerColumn === 'account_id' ? ownerId : null,
          ownerColumn === 'oauth_client_id' ? ownerId : null,
          kind,
          ciphertext,
          timestamp,
          timestamp
        );
      return;
    }
    database
      .prepare(
        `UPDATE credential_secrets
         SET ciphertext = ?, updated_at = ?
         WHERE ${ownerColumn} = ? AND kind = ?`
      )
      .run(ciphertext, timestamp, ownerId, kind);
  });
}

function readOwnedCredential(
  database: DatabaseSync,
  cipher: SecretCipher,
  ownerColumn: 'account_id' | 'oauth_client_id',
  ownerId: string,
  kind: typeof accountCredentialKind | typeof clientCredentialKind
): string {
  const row = database
    .prepare(`SELECT ciphertext FROM credential_secrets WHERE ${ownerColumn} = ? AND kind = ?`)
    .get(ownerId, kind);
  if (row === undefined) throw new PersistenceError('not-found');
  return decryptSecret(cipher, readCiphertext(row.ciphertext));
}

export function saveAccountRefreshToken(
  database: DatabaseSync,
  cipher: SecretCipher,
  accountId: string,
  plaintext: string,
  now: () => Date = () => new Date()
): void {
  saveOwnedCredential(
    database,
    cipher,
    'account_id',
    requireUuid(accountId),
    accountCredentialKind,
    plaintext,
    now
  );
}

export function readAccountRefreshToken(
  database: DatabaseSync,
  cipher: SecretCipher,
  accountId: string
): string {
  return readOwnedCredential(
    database,
    cipher,
    'account_id',
    requireUuid(accountId),
    accountCredentialKind
  );
}

export function saveClientSecret(
  database: DatabaseSync,
  cipher: SecretCipher,
  oauthClientId: string,
  plaintext: string,
  now: () => Date = () => new Date()
): void {
  saveOwnedCredential(
    database,
    cipher,
    'oauth_client_id',
    requireUuid(oauthClientId),
    clientCredentialKind,
    plaintext,
    now
  );
}

export function hasClientSecret(database: DatabaseSync, oauthClientId: string): boolean {
  const row = database
    .prepare(`SELECT id FROM credential_secrets WHERE oauth_client_id = ? AND kind = ?`)
    .get(requireUuid(oauthClientId), clientCredentialKind);
  return row !== undefined;
}

export function readClientSecret(
  database: DatabaseSync,
  cipher: SecretCipher,
  oauthClientId: string
): string {
  return readOwnedCredential(
    database,
    cipher,
    'oauth_client_id',
    requireUuid(oauthClientId),
    clientCredentialKind
  );
}
