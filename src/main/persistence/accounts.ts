import { randomUUID } from 'node:crypto';
import { type DatabaseSync } from 'node:sqlite';
import { historicalReadonlyGrant, parseGrantedScopes } from '../../shared/google-accounts.ts';
import { PersistenceError, rethrowPersistence } from './errors.ts';

export const accountStatuses = ['pending', 'connected', 'needs_reauth', 'disconnected'] as const;

export type AccountStatus = (typeof accountStatuses)[number];

export interface OAuthClientRecord {
  id: string;
  provider: string;
  clientId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectedAccountRecord {
  id: string;
  provider: string;
  providerAccountId: string;
  displayName: string | null;
  email: string | null;
  status: AccountStatus;
  oauthClientId: string;
  grantedScopes: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewOAuthClient {
  provider: string;
  clientId: string;
}

export interface NewConnectedAccount {
  provider: string;
  providerAccountId: string;
  displayName: string | null;
  email: string | null;
  status: AccountStatus;
  oauthClientId: string;
  grantedScopes?: string;
}

const providerPattern = /^[a-z0-9](?:[a-z0-9_-]{0,31})$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function requireProvider(value: string): string {
  if (typeof value !== 'string' || !providerPattern.test(value)) {
    throw new PersistenceError('invalid');
  }
  return value;
}

function requireToken(value: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maxLength ||
    hasControlCharacter(value)
  ) {
    throw new PersistenceError('invalid');
  }
  return value;
}

function optionalText(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  return requireToken(value, maxLength);
}

function isAccountStatus(value: string): value is AccountStatus {
  return accountStatuses.some((status) => status === value);
}

function requireStatus(value: string): AccountStatus {
  if (!isAccountStatus(value)) throw new PersistenceError('invalid');
  return value;
}

function requireUuid(value: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new PersistenceError('invalid');
  }
  return value;
}

function readText(value: unknown): string {
  if (typeof value !== 'string') throw new PersistenceError('internal');
  return value;
}

function readNullableText(value: unknown): string | null {
  if (value === null) return null;
  return readText(value);
}

function readGrant(value: unknown): string {
  const scopes = parseGrantedScopes(value);
  if (scopes === null) throw new PersistenceError('corrupt');
  return scopes.join(' ');
}

function readClient(row: Record<string, unknown>): OAuthClientRecord {
  return {
    id: requireUuid(readText(row.id)),
    provider: requireProvider(readText(row.provider)),
    clientId: readText(row.client_id),
    createdAt: readText(row.created_at),
    updatedAt: readText(row.updated_at)
  };
}

function readAccount(row: Record<string, unknown>): ConnectedAccountRecord {
  return {
    id: requireUuid(readText(row.id)),
    provider: requireProvider(readText(row.provider)),
    providerAccountId: readText(row.provider_account_id),
    displayName: readNullableText(row.display_name),
    email: readNullableText(row.email),
    status: requireStatus(readText(row.status)),
    oauthClientId: requireUuid(readText(row.oauth_client_id)),
    grantedScopes: readGrant(row.granted_scopes),
    createdAt: readText(row.created_at),
    updatedAt: readText(row.updated_at)
  };
}

export function createOAuthClient(
  database: DatabaseSync,
  input: NewOAuthClient,
  now: () => Date = () => new Date()
): OAuthClientRecord {
  const provider = requireProvider(input.provider);
  const clientId = requireToken(input.clientId, 512);
  const timestamp = now().toISOString();
  const id = randomUUID();
  try {
    database
      .prepare(
        `INSERT INTO oauth_clients (id, provider, client_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, provider, clientId, timestamp, timestamp);
  } catch (error) {
    rethrowPersistence(error, 'internal');
  }
  return {
    id,
    provider,
    clientId,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function deleteOAuthClient(database: DatabaseSync, oauthClientId: string): void {
  const id = requireUuid(oauthClientId);
  let changes = 0;
  try {
    changes = Number(database.prepare('DELETE FROM oauth_clients WHERE id = ?').run(id).changes);
  } catch (error) {
    rethrowPersistence(error, 'internal');
  }
  if (changes !== 1) throw new PersistenceError('not-found');
}

export function createConnectedAccount(
  database: DatabaseSync,
  input: NewConnectedAccount,
  now: () => Date = () => new Date()
): ConnectedAccountRecord {
  const provider = requireProvider(input.provider);
  const providerAccountId = requireToken(input.providerAccountId, 256);
  const displayName = optionalText(input.displayName, 256);
  const email = optionalText(input.email, 320);
  const status = requireStatus(input.status);
  const oauthClientId = requireUuid(input.oauthClientId);
  const grantedScopes = readGrant(input.grantedScopes ?? historicalReadonlyGrant);
  const timestamp = now().toISOString();
  const id = randomUUID();
  try {
    database
      .prepare(
        `INSERT INTO connected_accounts (
           id, provider, provider_account_id, display_name, email, status, oauth_client_id,
           granted_scopes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        provider,
        providerAccountId,
        displayName,
        email,
        status,
        oauthClientId,
        grantedScopes,
        timestamp,
        timestamp
      );
  } catch (error) {
    rethrowPersistence(error, 'internal');
  }
  return {
    id,
    provider,
    providerAccountId,
    displayName,
    email,
    status,
    oauthClientId,
    grantedScopes,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function getConnectedAccount(
  database: DatabaseSync,
  accountId: string
): ConnectedAccountRecord {
  const id = requireUuid(accountId);
  const row = database.prepare('SELECT * FROM connected_accounts WHERE id = ?').get(id);
  if (row === undefined) throw new PersistenceError('not-found');
  return readAccount(row);
}

export function deleteConnectedAccount(database: DatabaseSync, accountId: string): void {
  const id = requireUuid(accountId);
  let changes = 0;
  try {
    changes = Number(
      database.prepare('DELETE FROM connected_accounts WHERE id = ?').run(id).changes
    );
  } catch (error) {
    rethrowPersistence(error, 'internal');
  }
  if (changes !== 1) throw new PersistenceError('not-found');
}

export function readOAuthClient(database: DatabaseSync, oauthClientId: string): OAuthClientRecord {
  const id = requireUuid(oauthClientId);
  const row = database.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(id);
  if (row === undefined) throw new PersistenceError('not-found');
  return readClient(row);
}
