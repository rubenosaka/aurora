import { randomUUID } from 'node:crypto';
import { type DatabaseSync } from 'node:sqlite';
import {
  formatGrantedScopes,
  isGoogleClientId,
  isGoogleClientSecret,
  parseGrantedScopes
} from '../../shared/google-accounts.ts';
import {
  createOAuthClient,
  getConnectedAccount,
  readOAuthClient,
  type ConnectedAccountRecord,
  type OAuthClientRecord
} from './accounts.ts';
import { hasClientSecret, readAccountRefreshToken, saveClientSecret } from './credentials.ts';
import { withTransaction } from './database.ts';
import { PersistenceError } from './errors.ts';
import { type SecretCipher } from './safe-storage-cipher.ts';

const refreshTokenKind = 'refresh_token';

export class AccountLinkError extends Error {
  readonly code: 'client-in-use' | 'account-mismatch' | 'missing-refresh-token' | 'needs-reauth';

  constructor(
    code: 'client-in-use' | 'account-mismatch' | 'missing-refresh-token' | 'needs-reauth'
  ) {
    super(code);
    this.name = 'AccountLinkError';
    this.code = code;
  }
}

export interface AccountConnectionInput {
  oauthClientId: string;
  providerAccountId: string;
  displayName: string | null;
  email: string | null;
  refreshToken: string | null;
  expectedAccountId: string | null;
  grantedScopes: string;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function requireText(value: string, maxLength: number): string {
  if (value.length < 1 || value.length > maxLength || hasControlCharacter(value)) {
    throw new PersistenceError('invalid');
  }
  return value;
}

function optionalText(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  return requireText(value, maxLength);
}

function requireGrant(value: string): string {
  const parsed = parseGrantedScopes(value);
  if (parsed === null) throw new PersistenceError('invalid');
  return formatGrantedScopes(parsed);
}

function requireUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new PersistenceError('invalid');
  }
  return value;
}

function encryptSecret(cipher: SecretCipher, plaintext: string): Buffer {
  const secret = requireText(plaintext, 8192);
  try {
    const ciphertext = Buffer.from(cipher.encrypt(secret));
    if (ciphertext.length < 1) throw new PersistenceError('internal');
    return ciphertext;
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError('encryption-unavailable');
  }
}

function changesOf(changes: number | bigint): number {
  return Number(changes);
}

function countGoogleAccounts(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT COUNT(*) AS total FROM connected_accounts WHERE provider = 'google'")
    .get();
  return Number(row?.total ?? 0);
}

function findGoogleAccount(
  database: DatabaseSync,
  providerAccountId: string
): ConnectedAccountRecord | null {
  const row = database
    .prepare(
      `SELECT id FROM connected_accounts
       WHERE provider = 'google' AND provider_account_id = ?`
    )
    .get(providerAccountId);
  if (row === undefined) return null;
  return getConnectedAccount(database, String(row.id));
}

function credentialId(database: DatabaseSync, accountId: string): unknown {
  return database
    .prepare('SELECT id FROM credential_secrets WHERE account_id = ? AND kind = ?')
    .get(accountId, refreshTokenKind)?.id;
}

function insertRefreshToken(
  database: DatabaseSync,
  accountId: string,
  ciphertext: Buffer,
  timestamp: string
): void {
  database
    .prepare(
      `INSERT INTO credential_secrets (
         id, account_id, oauth_client_id, kind, ciphertext, created_at, updated_at
       ) VALUES (?, ?, NULL, ?, ?, ?, ?)`
    )
    .run(randomUUID(), accountId, refreshTokenKind, ciphertext, timestamp, timestamp);
}

function updateRefreshToken(
  database: DatabaseSync,
  accountId: string,
  ciphertext: Buffer,
  timestamp: string
): void {
  const changes = changesOf(
    database
      .prepare(
        `UPDATE credential_secrets
         SET ciphertext = ?, updated_at = ?
         WHERE account_id = ? AND kind = ?`
      )
      .run(ciphertext, timestamp, accountId, refreshTokenKind).changes
  );
  if (changes !== 1) throw new PersistenceError('not-found');
}

function writeRefreshToken(
  database: DatabaseSync,
  accountId: string,
  ciphertext: Buffer,
  timestamp: string
): void {
  if (credentialId(database, accountId) === undefined) {
    insertRefreshToken(database, accountId, ciphertext, timestamp);
    return;
  }
  updateRefreshToken(database, accountId, ciphertext, timestamp);
}

export function readGoogleClient(database: DatabaseSync): OAuthClientRecord | null {
  const rows = database.prepare("SELECT id FROM oauth_clients WHERE provider = 'google'").all();
  if (rows.length > 1) throw new PersistenceError('internal');
  const row = rows[0];
  if (row === undefined) return null;
  return readOAuthClient(database, String(row.id));
}

export function readGoogleClientState(database: DatabaseSync): {
  clientId: string | null;
  secretConfigured: boolean;
} {
  const client = readGoogleClient(database);
  if (client === null) return { clientId: null, secretConfigured: false };
  return { clientId: client.clientId, secretConfigured: hasClientSecret(database, client.id) };
}

export function saveGoogleClient(
  database: DatabaseSync,
  cipher: SecretCipher,
  clientId: string,
  clientSecret: string | null,
  now: () => Date = () => new Date()
): { clientId: string; secretConfigured: boolean } {
  if (clientSecret !== null && !isGoogleClientSecret(clientSecret)) {
    throw new PersistenceError('invalid');
  }
  if (clientSecret !== null) encryptSecret(cipher, clientSecret);
  const client = saveGoogleClientId(database, clientId, now);
  if (clientSecret !== null) saveClientSecret(database, cipher, client.id, clientSecret, now);
  return {
    clientId: client.clientId,
    secretConfigured: hasClientSecret(database, client.id)
  };
}

export function saveGoogleClientId(
  database: DatabaseSync,
  clientId: string,
  now: () => Date = () => new Date()
): OAuthClientRecord {
  if (!isGoogleClientId(clientId)) throw new PersistenceError('invalid');
  const existing = readGoogleClient(database);
  if (existing === null) {
    return createOAuthClient(database, { provider: 'google', clientId }, now);
  }
  if (existing.clientId === clientId) return existing;
  if (countGoogleAccounts(database) > 0) throw new AccountLinkError('client-in-use');
  const timestamp = now().toISOString();
  database
    .prepare(
      "UPDATE oauth_clients SET client_id = ?, updated_at = ? WHERE id = ? AND provider = 'google'"
    )
    .run(clientId, timestamp, existing.id);
  return readOAuthClient(database, existing.id);
}

export function listGoogleAccounts(database: DatabaseSync): ConnectedAccountRecord[] {
  const rows = database
    .prepare(
      `SELECT id FROM connected_accounts
       WHERE provider = 'google' AND status IN ('connected', 'needs_reauth')
       ORDER BY created_at ASC, id ASC`
    )
    .all();
  return rows.map((row) => getConnectedAccount(database, String(row.id)));
}

export function commitAccountConnection(
  database: DatabaseSync,
  cipher: SecretCipher,
  input: AccountConnectionInput,
  now: () => Date = () => new Date()
): ConnectedAccountRecord {
  const oauthClientId = requireUuid(input.oauthClientId);
  const providerAccountId = requireText(input.providerAccountId, 256);
  const displayName = optionalText(input.displayName, 256);
  const email = optionalText(input.email, 320);
  const grantedScopes = requireGrant(input.grantedScopes);
  const bySubject = findGoogleAccount(database, providerAccountId);
  let target: ConnectedAccountRecord | null = bySubject;
  if (input.expectedAccountId !== null) {
    const expectedId = requireUuid(input.expectedAccountId);
    let expected: ConnectedAccountRecord;
    try {
      expected = getConnectedAccount(database, expectedId);
    } catch (error) {
      if (error instanceof PersistenceError && error.code === 'not-found') {
        throw new AccountLinkError('account-mismatch');
      }
      throw error;
    }
    if (expected.provider !== 'google' || expected.providerAccountId !== providerAccountId) {
      throw new AccountLinkError('account-mismatch');
    }
    if (bySubject !== null && bySubject.id !== expected.id) {
      throw new AccountLinkError('account-mismatch');
    }
    target = expected;
  }
  if (target === null && input.refreshToken === null) {
    throw new AccountLinkError('missing-refresh-token');
  }
  if (target !== null && input.refreshToken === null) {
    try {
      readAccountRefreshToken(database, cipher, target.id);
    } catch (error) {
      if (
        error instanceof PersistenceError &&
        (error.code === 'decrypt-failed' || error.code === 'not-found')
      ) {
        throw new AccountLinkError('needs-reauth');
      }
      throw error;
    }
  }
  const ciphertext = input.refreshToken === null ? null : encryptSecret(cipher, input.refreshToken);
  const timestamp = now().toISOString();
  if (target === null) {
    const id = randomUUID();
    withTransaction(database, () => {
      database
        .prepare(
          `INSERT INTO connected_accounts (
             id, provider, provider_account_id, display_name, email, status, oauth_client_id,
             granted_scopes, created_at, updated_at
           ) VALUES (?, 'google', ?, ?, ?, 'connected', ?, ?, ?, ?)`
        )
        .run(
          id,
          providerAccountId,
          displayName,
          email,
          oauthClientId,
          grantedScopes,
          timestamp,
          timestamp
        );
      if (ciphertext === null) throw new PersistenceError('invalid');
      insertRefreshToken(database, id, ciphertext, timestamp);
    });
    return getConnectedAccount(database, id);
  }
  const accountId = target.id;
  withTransaction(database, () => {
    const updated = changesOf(
      database
        .prepare(
          `UPDATE connected_accounts
           SET display_name = ?, email = ?, status = 'connected', granted_scopes = ?, updated_at = ?
           WHERE id = ? AND provider = 'google' AND provider_account_id = ?`
        )
        .run(displayName, email, grantedScopes, timestamp, accountId, providerAccountId).changes
    );
    if (updated !== 1) throw new PersistenceError('not-found');
    if (ciphertext === null) {
      if (credentialId(database, accountId) === undefined) throw new PersistenceError('not-found');
      return;
    }
    writeRefreshToken(database, accountId, ciphertext, timestamp);
  });
  return getConnectedAccount(database, accountId);
}

export function saveGrantedScopes(
  database: DatabaseSync,
  accountId: string,
  grantedScopes: string,
  now: () => Date = () => new Date()
): void {
  const id = requireUuid(accountId);
  const scopes = requireGrant(grantedScopes);
  const timestamp = now().toISOString();
  const updated = changesOf(
    database
      .prepare(
        `UPDATE connected_accounts
         SET granted_scopes = ?, updated_at = ?
         WHERE id = ? AND provider = 'google'`
      )
      .run(scopes, timestamp, id).changes
  );
  if (updated !== 1) throw new PersistenceError('not-found');
}

export function replaceAccountRefreshToken(
  database: DatabaseSync,
  cipher: SecretCipher,
  accountId: string,
  refreshToken: string,
  now: () => Date = () => new Date()
): void {
  const id = requireUuid(accountId);
  const ciphertext = encryptSecret(cipher, refreshToken);
  const timestamp = now().toISOString();
  withTransaction(database, () => {
    updateRefreshToken(database, id, ciphertext, timestamp);
    database
      .prepare('UPDATE connected_accounts SET updated_at = ? WHERE id = ?')
      .run(timestamp, id);
  });
}

export function noteGoogleReauth(
  database: DatabaseSync,
  accountId: string,
  now: () => Date = () => new Date()
): void {
  const id = requireUuid(accountId);
  const timestamp = now().toISOString();
  const updated = changesOf(
    database
      .prepare(
        `UPDATE connected_accounts
         SET status = 'needs_reauth', updated_at = ?
         WHERE id = ? AND provider = 'google'`
      )
      .run(timestamp, id).changes
  );
  if (updated !== 1) throw new PersistenceError('not-found');
}

export function markRefreshTokenUnusable(
  database: DatabaseSync,
  accountId: string,
  now: () => Date = () => new Date()
): void {
  const id = requireUuid(accountId);
  const timestamp = now().toISOString();
  withTransaction(database, () => {
    const updated = changesOf(
      database
        .prepare(
          `UPDATE connected_accounts
           SET status = 'needs_reauth', updated_at = ?
           WHERE id = ? AND provider = 'google'`
        )
        .run(timestamp, id).changes
    );
    if (updated !== 1) throw new PersistenceError('not-found');
    database
      .prepare('DELETE FROM credential_secrets WHERE account_id = ? AND kind = ?')
      .run(id, refreshTokenKind);
  });
}
