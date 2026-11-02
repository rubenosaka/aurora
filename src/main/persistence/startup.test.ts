import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { type DatabaseSync } from 'node:sqlite';
import { PersistenceError, persistenceErrorCodes } from './errors.ts';
import { databaseFilePath, openApplicationDatabase, persistenceStartupMessage } from './startup.ts';

describe('startup persistence', () => {
  it('uses separate files for development and packaged profiles', () => {
    const root = join('user-data');
    assert.equal(databaseFilePath(root, true), join(root, 'aurora.sqlite'));
    assert.equal(databaseFilePath(root, false), join(root, 'dev', 'aurora.sqlite'));
  });

  it('stops before creating directories when encryption is unavailable', () => {
    const calls: string[] = [];
    assert.throws(
      () =>
        openApplicationDatabase({
          userDataPath: join('user-data'),
          isPackaged: false,
          encryptionAvailable: false,
          ensureDirectory: () => {
            calls.push('directory');
          },
          openDatabase: () => {
            calls.push('open');
            return {} as DatabaseSync;
          }
        }),
      (error) => error instanceof PersistenceError && error.code === 'encryption-unavailable'
    );
    assert.deepEqual(calls, []);
  });

  it('opens the packaged path only after the directory exists', () => {
    const opened: string[] = [];
    const directories: string[] = [];
    const database = { opened: true } as unknown as DatabaseSync;
    const result = openApplicationDatabase({
      userDataPath: join('user-data'),
      isPackaged: true,
      encryptionAvailable: true,
      ensureDirectory: (directory) => {
        directories.push(directory);
      },
      openDatabase: (filePath) => {
        opened.push(filePath);
        return database;
      }
    });
    assert.equal(result, database);
    assert.deepEqual(directories, [join('user-data')]);
    assert.deepEqual(opened, [join('user-data', 'aurora.sqlite')]);
  });

  it('reports directory and open failures without their original text', () => {
    assert.throws(
      () =>
        openApplicationDatabase({
          userDataPath: join('user-data'),
          isPackaged: false,
          encryptionAvailable: true,
          ensureDirectory: () => {
            throw new Error('EPERM C:\\Users\\secret\\aurora');
          },
          openDatabase: () => {
            throw new Error('should not open');
          }
        }),
      (error) => {
        assert.ok(error instanceof PersistenceError);
        assert.equal(error.code, 'unavailable');
        assert.equal(error.message.includes('secret'), false);
        return true;
      }
    );
    assert.throws(
      () =>
        openApplicationDatabase({
          userDataPath: join('user-data'),
          isPackaged: true,
          encryptionAvailable: true,
          ensureDirectory: () => undefined,
          openDatabase: () => {
            throw new Error('C:\\Users\\secret\\aurora.sqlite');
          }
        }),
      (error) => error instanceof PersistenceError && error.code === 'unavailable'
    );
  });

  it('preserves typed persistence failures and sanitizes every startup message', () => {
    assert.throws(
      () =>
        openApplicationDatabase({
          userDataPath: join('user-data'),
          isPackaged: true,
          encryptionAvailable: true,
          ensureDirectory: () => undefined,
          openDatabase: () => {
            throw new PersistenceError('corrupt');
          }
        }),
      (error) => error instanceof PersistenceError && error.code === 'corrupt'
    );
    const message = persistenceStartupMessage(new Error('C:\\Users\\secret\\aurora.sqlite'));
    assert.equal(message.includes('secret'), false);
    assert.equal(message.includes('\\'), false);
    for (const code of persistenceErrorCodes) {
      const text = persistenceStartupMessage(new PersistenceError(code));
      assert.equal(text.includes('\\'), false);
      assert.equal(text.includes('/'), false);
    }
  });
});
