import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { historicalReadonlyGrant } from '../../shared/google-accounts.ts';
import { PersistenceError, rethrowPersistence } from './errors.ts';

export const schemaVersion = 3;

const openOptions = {
  enableForeignKeyConstraints: true,
  allowExtension: false
} as const;

const migrationSql = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, client_id)
) STRICT;

CREATE TABLE connected_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  status TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE RESTRICT,
  granted_scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_account_id),
  CHECK (status IN ('pending', 'connected', 'needs_reauth', 'disconnected'))
) STRICT;

CREATE TABLE credential_secrets (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES connected_accounts (id) ON DELETE CASCADE,
  oauth_client_id TEXT REFERENCES oauth_clients (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (account_id IS NOT NULL AND oauth_client_id IS NULL AND kind = 'refresh_token') OR
    (account_id IS NULL AND oauth_client_id IS NOT NULL AND kind = 'client_secret')
  ),
  UNIQUE (account_id, kind),
  UNIQUE (oauth_client_id, kind)
) STRICT;

CREATE TABLE mailbox_sync (
  account_id TEXT PRIMARY KEY REFERENCES connected_accounts (id) ON DELETE CASCADE,
  history_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    length(history_id) BETWEEN 1 AND 32 AND
    history_id GLOB '[0-9]*' AND
    history_id NOT GLOB '*[^0-9]*'
  )
) STRICT;

CREATE TABLE notified_messages (
  account_id TEXT NOT NULL REFERENCES connected_accounts (id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  notified_at TEXT NOT NULL,
  PRIMARY KEY (account_id, message_id),
  CHECK (length(message_id) BETWEEN 1 AND 128)
) STRICT;
`;

const syncSchemaSql = `
CREATE TABLE mailbox_sync (
  account_id TEXT PRIMARY KEY REFERENCES connected_accounts (id) ON DELETE CASCADE,
  history_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    length(history_id) BETWEEN 1 AND 32 AND
    history_id GLOB '[0-9]*' AND
    history_id NOT GLOB '*[^0-9]*'
  )
) STRICT;

CREATE TABLE notified_messages (
  account_id TEXT NOT NULL REFERENCES connected_accounts (id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  notified_at TEXT NOT NULL,
  PRIMARY KEY (account_id, message_id),
  CHECK (length(message_id) BETWEEN 1 AND 128)
) STRICT;
`;

const migrationStampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function settingsSql(stamp: string): string {
  return `
INSERT INTO app_settings (key, value, updated_at)
SELECT 'gmail.notifications', 'on', '${stamp}'
WHERE NOT EXISTS (
  SELECT 1 FROM app_settings WHERE key = 'gmail.notifications'
);
INSERT INTO app_settings (key, value, updated_at)
SELECT 'gmail.notification_content', 'show', '${stamp}'
WHERE NOT EXISTS (
  SELECT 1 FROM app_settings WHERE key = 'gmail.notification_content'
);
`;
}

function closeQuietly(database: DatabaseSync | null): void {
  if (database === null) return;
  try {
    database.close();
  } catch (error) {
    void error;
  }
}

export function assertForeignKeys(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON');
  const row = database.prepare('PRAGMA foreign_keys').get();
  if (row?.foreign_keys !== 1) throw new PersistenceError('internal');
}

function assertQuickCheck(database: DatabaseSync): void {
  let rows: { quick_check?: unknown }[];
  try {
    rows = database.prepare('PRAGMA quick_check').all();
  } catch (error) {
    rethrowPersistence(error, 'corrupt');
  }
  if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') {
    throw new PersistenceError('corrupt');
  }
}

function tableExists(database: DatabaseSync, name: string): boolean {
  const row = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

export function readSchemaVersion(database: DatabaseSync): number {
  if (!tableExists(database, 'schema_migrations')) return 0;
  const row = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  const version = row?.version;
  if (version === null || version === undefined) return 0;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new PersistenceError('corrupt');
  }
  return version;
}

function hasUserTables(database: DatabaseSync): boolean {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  return rows.length > 0;
}

function configureConnection(database: DatabaseSync): void {
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA journal_mode = WAL');
  assertForeignKeys(database);
}

function applyMigration(
  database: DatabaseSync,
  version: number,
  sqlFor: (stamp: string) => string,
  now: () => Date
): void {
  try {
    database.exec('BEGIN IMMEDIATE');
  } catch (error) {
    rethrowPersistence(error, 'migration-failed');
  }
  try {
    const stamp = now().toISOString();
    if (!migrationStampPattern.test(stamp)) throw new PersistenceError('migration-failed');
    database.exec(sqlFor(stamp));
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(version, stamp);
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch (rollbackError) {
      void rollbackError;
    }
    rethrowPersistence(error, 'migration-failed');
  }
}

function migrate(database: DatabaseSync, now: () => Date): void {
  const version = readSchemaVersion(database);
  if (version === schemaVersion) return;
  if (version === 0) {
    applyMigration(database, schemaVersion, (stamp) => migrationSql + settingsSql(stamp), now);
    return;
  }
  if (version === 1) {
    applyMigration(
      database,
      schemaVersion,
      (stamp) =>
        `ALTER TABLE connected_accounts ADD COLUMN granted_scopes TEXT NOT NULL DEFAULT '${historicalReadonlyGrant}';\n${syncSchemaSql}\n${settingsSql(stamp)}`,
      now
    );
    return;
  }
  if (version === 2) {
    applyMigration(
      database,
      schemaVersion,
      (stamp) => `${syncSchemaSql}\n${settingsSql(stamp)}`,
      now
    );
    return;
  }
  throw new PersistenceError('unsupported-schema');
}

function openWritable(filePath: string, now: () => Date): DatabaseSync {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(filePath, openOptions);
    assertForeignKeys(database);
    const version = readSchemaVersion(database);
    if (version > schemaVersion) throw new PersistenceError('unsupported-schema');
    if (version === 0 && hasUserTables(database)) throw new PersistenceError('corrupt');
    migrate(database, now);
    assertQuickCheck(database);
    configureConnection(database);
    return database;
  } catch (error) {
    closeQuietly(database);
    rethrowPersistence(error, 'unavailable');
  }
}

function inspectDatabase(filePath: string): void {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(filePath, { ...openOptions, readOnly: true });
    assertForeignKeys(database);
    assertQuickCheck(database);
    const version = readSchemaVersion(database);
    if (version > schemaVersion) throw new PersistenceError('unsupported-schema');
    if (version === 0 && hasUserTables(database)) throw new PersistenceError('corrupt');
    database.close();
    database = null;
  } catch (error) {
    closeQuietly(database);
    rethrowPersistence(error, 'corrupt');
  }
}

function probeExisting(filePath: string): void {
  const directory = mkdtempSync(join(tmpdir(), 'aurora-probe-'));
  const copyPath = join(directory, 'probe.sqlite');
  try {
    copyFileSync(filePath, copyPath);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${filePath}${suffix}`;
      if (existsSync(sidecar)) copyFileSync(sidecar, `${copyPath}${suffix}`);
    }
    inspectDatabase(copyPath);
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    rethrowPersistence(error, 'unavailable');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function openAuroraDatabase(
  filePath: string,
  now: () => Date = () => new Date()
): DatabaseSync {
  if (!existsSync(filePath)) return openWritable(filePath, now);
  probeExisting(filePath);
  return openWritable(filePath, now);
}

export function withTransaction(database: DatabaseSync, work: () => void): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    work();
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch (rollbackError) {
      void rollbackError;
    }
    rethrowPersistence(error, 'internal');
  }
}
