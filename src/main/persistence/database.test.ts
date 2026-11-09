import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { historicalReadonlyGrant } from '../../shared/google-accounts.ts';
import {
  assertForeignKeys,
  openAuroraDatabase,
  readSchemaVersion,
  schemaVersion
} from './database.ts';
import { PersistenceError } from './errors.ts';

const directories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aurora-persistence-'));
  directories.push(directory);
  return directory;
}

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function isCode(code: string) {
  return (error: unknown) => error instanceof PersistenceError && error.code === code;
}

describe('openAuroraDatabase', () => {
  it('creates a database and reopens it at the same schema version', () => {
    const file = join(tempDir(), 'aurora.sqlite');
    const created = openAuroraDatabase(file);
    assert.equal(readSchemaVersion(created), schemaVersion);
    assertForeignKeys(created);
    const journal = created.prepare('PRAGMA journal_mode').get();
    const timeout = created.prepare('PRAGMA busy_timeout').get();
    assert.equal(journal?.journal_mode, 'wal');
    assert.equal(timeout?.timeout, 5000);
    const tables = created
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables.sort(), [
      'app_settings',
      'connected_accounts',
      'credential_secrets',
      'mailbox_sync',
      'notified_messages',
      'oauth_clients',
      'schema_migrations'
    ]);
    created.close();

    const reopened = openAuroraDatabase(file);
    assert.equal(readSchemaVersion(reopened), schemaVersion);
    const migrations = reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get();
    assert.equal(migrations?.count, 1);
    reopened.close();
  });

  it('migrates an empty sqlite file once', () => {
    const file = join(tempDir(), 'aurora.sqlite');
    const empty = new DatabaseSync(file);
    empty.close();
    const database = openAuroraDatabase(file);
    assert.equal(readSchemaVersion(database), schemaVersion);
    database.close();
    const again = openAuroraDatabase(file);
    const versions = again.prepare('SELECT version FROM schema_migrations').all();
    assert.equal(versions.length, 1);
    assert.equal(versions[0]?.version, schemaVersion);
    again.close();
  });

  it('rejects a newer schema version without modifying the file or its sidecars', () => {
    const file = join(tempDir(), 'aurora.sqlite');
    const database = openAuroraDatabase(file);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(schemaVersion + 1, '2026-10-17T00:00:00.000Z');
    database.close();
    const before = {
      database: readFileSync(file),
      files: readdirSync(join(file, '..')).sort()
    };
    assert.throws(() => openAuroraDatabase(file), isCode('unsupported-schema'));
    assert.deepEqual(readFileSync(file), before.database);
    assert.deepEqual(readdirSync(join(file, '..')).sort(), before.files);
  });

  it('leaves a damaged file and its directory unchanged', () => {
    const directory = tempDir();
    const file = join(directory, 'aurora.sqlite');
    writeFileSync(file, Buffer.from('not-a-database'));
    const before = readFileSync(file);
    assert.throws(() => openAuroraDatabase(file), isCode('corrupt'));
    assert.deepEqual(readFileSync(file), before);
    assert.deepEqual(readdirSync(directory).sort(), ['aurora.sqlite']);
    const error = new PersistenceError('corrupt');
    assert.equal(error.message.includes('aurora.sqlite'), false);
  });

  it('does not migrate an unrelated sqlite database', () => {
    const file = join(tempDir(), 'aurora.sqlite');
    const database = new DatabaseSync(file);
    database.exec('CREATE TABLE other (id INTEGER PRIMARY KEY)');
    database.close();
    const before = readFileSync(file);
    assert.throws(() => openAuroraDatabase(file), isCode('corrupt'));
    assert.deepEqual(readFileSync(file), before);
    const probe = new DatabaseSync(file, { readOnly: true });
    const names = probe
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    probe.close();
    assert.deepEqual(names, ['other']);
  });

  it('rolls back a failed migration and keeps the same file', () => {
    const file = join(tempDir(), 'aurora.sqlite');
    assert.throws(
      () =>
        openAuroraDatabase(file, () => {
          throw new Error('clock failed secret-value');
        }),
      isCode('migration-failed')
    );
    const probe = new DatabaseSync(file, { readOnly: true });
    const names = probe
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();
    probe.close();
    assert.deepEqual(names, []);
    const database = openAuroraDatabase(file);
    assert.equal(readSchemaVersion(database), schemaVersion);
    database.close();
  });

  it('keeps an existing version 1 account read-only', () => {
    const file = join(tempDir(), 'aurora.sqlite');
    const legacy = new DatabaseSync(file);
    legacy.exec(`
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (provider, provider_account_id)
      ) STRICT;
    `);
    legacy
      .prepare(
        `INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-10-17T00:00:00.000Z')`
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO oauth_clients (id, provider, client_id, created_at, updated_at)
         VALUES ('00000000-0000-4000-8000-000000000010', 'google', 'client.apps.googleusercontent.com',
                 '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:00.000Z')`
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO connected_accounts (
           id, provider, provider_account_id, display_name, email, status, oauth_client_id,
           created_at, updated_at
         ) VALUES (
           '00000000-0000-4000-8000-000000000011', 'google', 'google-user', 'Ada',
           'ada@example.com', 'connected', '00000000-0000-4000-8000-000000000010',
           '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:00.000Z'
         )`
      )
      .run();
    legacy.close();
    const database = openAuroraDatabase(file);
    const row = database.prepare('SELECT granted_scopes FROM connected_accounts').get() as {
      granted_scopes: string;
    };
    assert.equal(row.granted_scopes, historicalReadonlyGrant);
    assert.equal(readSchemaVersion(database), schemaVersion);
    const notifications = database
      .prepare("SELECT value FROM app_settings WHERE key = 'gmail.notifications'")
      .get() as { value: string };
    assert.equal(notifications.value, 'on');
    assert.equal(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'mailbox_sync'").get() !==
        undefined,
      true
    );
    database.close();
  });

  it('migrates schema version 2 and keeps the account', () => {
    const file = join(tempDir(), 'aurora.sqlite');
    const legacy = new DatabaseSync(file);
    legacy.exec(`
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
        UNIQUE (provider, provider_account_id)
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
        )
      ) STRICT;
    `);
    legacy
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)')
      .run('2026-10-17T00:00:00.000Z');
    legacy
      .prepare(
        `INSERT INTO oauth_clients (id, provider, client_id, created_at, updated_at)
         VALUES ('00000000-0000-4000-8000-000000000010', 'google', 'client.apps.googleusercontent.com',
                 '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:00.000Z')`
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO connected_accounts (
           id, provider, provider_account_id, display_name, email, status, oauth_client_id,
           granted_scopes, created_at, updated_at
         ) VALUES (
           '00000000-0000-4000-8000-000000000011', 'google', 'google-user', 'Ada',
           'ada@example.com', 'connected', '00000000-0000-4000-8000-000000000010',
           'openid email profile https://www.googleapis.com/auth/gmail.modify',
           '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:00.000Z'
         )`
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO credential_secrets (
           id, account_id, oauth_client_id, kind, ciphertext, created_at, updated_at
         ) VALUES (
           '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000011',
           NULL, 'refresh_token', ?, '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:00.000Z'
         )`
      )
      .run(Buffer.from('ciphertext'));
    legacy.close();
    const database = openAuroraDatabase(file, () => new Date('2026-11-09T10:00:00.000Z'));
    assert.equal(readSchemaVersion(database), schemaVersion);
    const account = database
      .prepare('SELECT email, granted_scopes FROM connected_accounts')
      .get() as {
      email: string;
      granted_scopes: string;
    };
    assert.equal(account.email, 'ada@example.com');
    assert.equal(
      account.granted_scopes,
      'openid email profile https://www.googleapis.com/auth/gmail.modify'
    );
    const secret = database.prepare('SELECT ciphertext FROM credential_secrets').get() as {
      ciphertext: Buffer;
    };
    assert.equal(Buffer.from(secret.ciphertext).equals(Buffer.from('ciphertext')), true);
    const content = database
      .prepare("SELECT value FROM app_settings WHERE key = 'gmail.notification_content'")
      .get() as { value: string };
    assert.equal(content.value, 'show');
    database.close();
  });

  it('rolls back a failed schema version 2 migration', () => {
    const file = join(tempDir(), 'aurora.sqlite');
    const legacy = new DatabaseSync(file);
    legacy.exec(`
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
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE connected_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        display_name TEXT,
        email TEXT,
        status TEXT NOT NULL,
        oauth_client_id TEXT NOT NULL,
        granted_scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    legacy
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)')
      .run('2026-10-17T00:00:00.000Z');
    legacy.close();
    assert.throws(
      () =>
        openAuroraDatabase(file, () => {
          throw new Error('clock failed');
        }),
      isCode('migration-failed')
    );
    const probe = new DatabaseSync(file, { readOnly: true });
    assert.equal(readSchemaVersion(probe), 2);
    assert.equal(
      probe.prepare("SELECT name FROM sqlite_master WHERE name = 'mailbox_sync'").get(),
      undefined
    );
    probe.close();
    const database = openAuroraDatabase(file);
    assert.equal(readSchemaVersion(database), schemaVersion);
    database.close();
  });

  it('reports a directory path as unavailable', () => {
    const directory = tempDir();
    assert.throws(() => openAuroraDatabase(directory), isCode('unavailable'));
    assert.equal(readdirSync(directory).length, 0);
  });
});
