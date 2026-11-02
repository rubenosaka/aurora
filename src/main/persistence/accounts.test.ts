import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  createConnectedAccount,
  createOAuthClient,
  deleteConnectedAccount,
  deleteOAuthClient,
  getConnectedAccount,
  readOAuthClient
} from './accounts.ts';
import { openAuroraDatabase } from './database.ts';
import { PersistenceError } from './errors.ts';

const directories: string[] = [];

function openTemp() {
  const directory = mkdtempSync(join(tmpdir(), 'aurora-accounts-'));
  directories.push(directory);
  return openAuroraDatabase(join(directory, 'aurora.sqlite'));
}

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function codeOf(error: unknown): string {
  assert.ok(error instanceof PersistenceError);
  return error.code;
}

describe('accounts', () => {
  it('stores several accounts for one provider and keeps email optional', () => {
    const database = openTemp();
    const client = createOAuthClient(database, {
      provider: 'google',
      clientId: 'desktop-client.apps.googleusercontent.com'
    });
    const spotify = createOAuthClient(database, {
      provider: 'spotify',
      clientId: 'spotify-desktop-client'
    });
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
      status: 'pending',
      oauthClientId: client.id
    });
    const music = createConnectedAccount(database, {
      provider: 'spotify',
      providerAccountId: 'spotify-user-1',
      displayName: 'Listener',
      email: null,
      status: 'connected',
      oauthClientId: spotify.id
    });
    assert.equal(first.email, 'ada@example.com');
    assert.equal(second.email, null);
    assert.equal(music.provider, 'spotify');
    assert.deepEqual(getConnectedAccount(database, first.id).providerAccountId, 'google-user-1');
    assert.equal(readOAuthClient(database, client.id).clientId, client.clientId);
    const storedClient = database
      .prepare('SELECT client_id FROM oauth_clients WHERE id = ?')
      .get(client.id);
    assert.equal(storedClient?.client_id, 'desktop-client.apps.googleusercontent.com');
    database.close();
  });

  it('rejects duplicate accounts and duplicate oauth clients', () => {
    const database = openTemp();
    const client = createOAuthClient(database, { provider: 'google', clientId: 'client-one' });
    createConnectedAccount(database, {
      provider: 'google',
      providerAccountId: 'same-user',
      displayName: null,
      email: null,
      status: 'connected',
      oauthClientId: client.id
    });
    assert.throws(
      () =>
        createConnectedAccount(database, {
          provider: 'google',
          providerAccountId: 'same-user',
          displayName: null,
          email: null,
          status: 'connected',
          oauthClientId: client.id
        }),
      (error) => codeOf(error) === 'constraint'
    );
    assert.throws(
      () => createOAuthClient(database, { provider: 'google', clientId: 'client-one' }),
      (error) => codeOf(error) === 'constraint'
    );
    const accounts = database.prepare('SELECT COUNT(*) AS count FROM connected_accounts').get();
    assert.equal(accounts?.count, 1);
    database.close();
  });

  it('enforces foreign keys for account ownership', () => {
    const database = openTemp();
    const foreignKeys = database.prepare('PRAGMA foreign_keys').get();
    assert.equal(foreignKeys?.foreign_keys, 1);
    assert.throws(
      () =>
        createConnectedAccount(database, {
          provider: 'google',
          providerAccountId: 'orphan',
          displayName: null,
          email: null,
          status: 'pending',
          oauthClientId: '00000000-0000-4000-8000-000000000000'
        }),
      (error) => codeOf(error) === 'constraint'
    );
    const accounts = database.prepare('SELECT COUNT(*) AS count FROM connected_accounts').get();
    assert.equal(accounts?.count, 0);
    database.close();
  });

  it('refuses to delete an oauth client that still has an account', () => {
    const database = openTemp();
    const client = createOAuthClient(database, { provider: 'google', clientId: 'client-one' });
    createConnectedAccount(database, {
      provider: 'google',
      providerAccountId: 'google-user-1',
      displayName: null,
      email: null,
      status: 'connected',
      oauthClientId: client.id
    });
    assert.throws(
      () => deleteOAuthClient(database, client.id),
      (error) => codeOf(error) === 'constraint'
    );
    const clients = database.prepare('SELECT COUNT(*) AS count FROM oauth_clients').get();
    assert.equal(clients?.count, 1);
    database.close();
  });

  it('rejects malformed account input before writing', () => {
    const database = openTemp();
    const client = createOAuthClient(database, { provider: 'google', clientId: 'client-one' });
    assert.throws(
      () =>
        createConnectedAccount(database, {
          provider: 'Google',
          providerAccountId: 'user',
          displayName: null,
          email: null,
          status: 'connected',
          oauthClientId: client.id
        }),
      (error) => codeOf(error) === 'invalid'
    );
    assert.throws(
      () => deleteConnectedAccount(database, 'not-a-uuid'),
      (error) => codeOf(error) === 'invalid'
    );
    assert.throws(
      () =>
        createConnectedAccount(database, {
          provider: 'google',
          providerAccountId: 'user',
          displayName: 'bad\nname',
          email: null,
          status: 'connected',
          oauthClientId: client.id
        }),
      (error) => codeOf(error) === 'invalid'
    );
    assert.throws(
      () => deleteConnectedAccount(database, '00000000-0000-4000-8000-000000000000'),
      (error) => codeOf(error) === 'not-found'
    );
    database.close();
  });
});
