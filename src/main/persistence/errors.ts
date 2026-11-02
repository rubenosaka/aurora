export const persistenceErrorCodes = [
  'unavailable',
  'corrupt',
  'unsupported-schema',
  'migration-failed',
  'encryption-unavailable',
  'decrypt-failed',
  'constraint',
  'not-found',
  'invalid',
  'internal'
] as const;

export type PersistenceErrorCode = (typeof persistenceErrorCodes)[number];

const messages: Record<PersistenceErrorCode, string> = {
  unavailable: 'The local database is unavailable.',
  corrupt: 'The local database is damaged.',
  'unsupported-schema': 'The local database was created by a newer version.',
  'migration-failed': 'The local database could not be prepared.',
  'encryption-unavailable': 'Credential protection is unavailable.',
  'decrypt-failed': 'The saved credential could not be read.',
  constraint: 'The local database rejected the change.',
  'not-found': 'The requested record does not exist.',
  invalid: 'The persistence request was rejected.',
  internal: 'The local database request failed.'
};

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode) {
    super(messages[code]);
    this.name = 'PersistenceError';
    this.code = code;
  }
}

export function persistenceCodeForSqlite(
  errcode: number,
  fallback: PersistenceErrorCode
): PersistenceErrorCode {
  const primary = errcode & 0xff;
  if (primary === 11 || primary === 26) return 'corrupt';
  if (primary === 19) return 'constraint';
  if (
    primary === 3 ||
    primary === 5 ||
    primary === 6 ||
    primary === 8 ||
    primary === 10 ||
    primary === 14
  ) {
    return 'unavailable';
  }
  return fallback;
}

export function rethrowPersistence(error: unknown, fallback: PersistenceErrorCode): never {
  if (error instanceof PersistenceError) throw error;
  if (typeof error === 'object' && error !== null && 'errcode' in error) {
    const errcode = error.errcode;
    if (typeof errcode === 'number') {
      throw new PersistenceError(persistenceCodeForSqlite(errcode, fallback));
    }
  }
  throw new PersistenceError(fallback);
}
