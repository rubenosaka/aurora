import { dirname, join } from 'node:path';
import { type DatabaseSync } from 'node:sqlite';
import { PersistenceError } from './errors.ts';

export function databaseFilePath(userDataPath: string, isPackaged: boolean): string {
  if (isPackaged) return join(userDataPath, 'aurora.sqlite');
  return join(userDataPath, 'dev', 'aurora.sqlite');
}

export function persistenceStartupMessage(error: unknown): string {
  if (error instanceof PersistenceError) return error.message;
  return new PersistenceError('internal').message;
}

export function openApplicationDatabase(input: {
  userDataPath: string;
  isPackaged: boolean;
  encryptionAvailable: boolean;
  ensureDirectory: (directory: string) => void;
  openDatabase: (filePath: string) => DatabaseSync;
}): DatabaseSync {
  if (!input.encryptionAvailable) {
    throw new PersistenceError('encryption-unavailable');
  }
  if (input.userDataPath.length < 1) throw new PersistenceError('unavailable');
  const filePath = databaseFilePath(input.userDataPath, input.isPackaged);
  try {
    input.ensureDirectory(dirname(filePath));
  } catch (error) {
    void error;
    throw new PersistenceError('unavailable');
  }
  try {
    return input.openDatabase(filePath);
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError('unavailable');
  }
}
