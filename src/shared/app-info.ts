export const appInfoChannel = 'app:get-info';

export const appPlatforms = [
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32'
] as const;

export type AppPlatform = (typeof appPlatforms)[number];

export interface AppInfo {
  name: string;
  version: string;
  platform: AppPlatform;
}

export const appInfoErrorCodes = [
  'unauthorized',
  'invalid-request',
  'invalid-response',
  'internal'
] as const;

export type AppInfoErrorCode = (typeof appInfoErrorCodes)[number];

export type IpcResult<T> =
  { ok: true; value: T } | { ok: false; error: { code: AppInfoErrorCode } };

const safeMessages: Record<AppInfoErrorCode, string> = {
  unauthorized: 'Request rejected.',
  'invalid-request': 'Request rejected.',
  'invalid-response': 'Response rejected.',
  internal: 'Request failed.'
};

export class AuroraIpcError extends Error {
  readonly code: AppInfoErrorCode;

  constructor(code: AppInfoErrorCode) {
    super(safeMessages[code]);
    this.name = 'AuroraIpcError';
    this.code = code;
  }
}

const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const actual = Object.getOwnPropertyNames(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

export function isAppInfo(value: unknown): value is AppInfo {
  if (!isRecord(value) || !hasExactKeys(value, ['name', 'version', 'platform'])) return false;
  if (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 64)
    return false;
  if (/[\u0000-\u001f]/.test(value.name)) return false;
  if (typeof value.version !== 'string' || !versionPattern.test(value.version)) return false;
  return (
    typeof value.platform === 'string' &&
    appPlatforms.some((platform) => platform === value.platform)
  );
}

function isErrorCode(value: unknown): value is AppInfoErrorCode {
  return typeof value === 'string' && appInfoErrorCodes.some((code) => code === value);
}

export function parseIpcResult(value: unknown): IpcResult<AppInfo> {
  const invalid: IpcResult<AppInfo> = { ok: false, error: { code: 'invalid-response' } };
  if (!isRecord(value) || typeof value.ok !== 'boolean') return invalid;
  if (value.ok) {
    if (!hasExactKeys(value, ['ok', 'value']) || !isAppInfo(value.value)) return invalid;
    return { ok: true, value: value.value };
  }
  if (!hasExactKeys(value, ['ok', 'error']) || !isRecord(value.error)) return invalid;
  if (!hasExactKeys(value.error, ['code']) || !isErrorCode(value.error.code)) return invalid;
  return { ok: false, error: { code: value.error.code } };
}

export function unwrapAppInfo(value: unknown): AppInfo {
  const result = parseIpcResult(value);
  if (!result.ok) throw new AuroraIpcError(result.error.code);
  return result.value;
}

export interface AuroraBridge {
  app: {
    getInfo(): Promise<IpcResult<AppInfo>>;
  };
}

export interface AuroraApi {
  app: {
    getInfo(): Promise<AppInfo>;
  };
}
